import json
import logging
import os
from abc import ABC
from typing import Any, ClassVar, Dict, List, Optional, Tuple, Type

from aliyun.log import GetLogsRequest, LogClient
from aliyun.log.logexception import LogException
from pydantic import ConfigDict, Field, model_validator

from holmes.core.tools import (
    CallablePrerequisite,
    StructuredToolResult,
    StructuredToolResultStatus,
    Tool,
    ToolInvokeContext,
    ToolParameter,
    Toolset,
    ToolsetTag,
)
from holmes.plugins.toolsets.consts import STANDARD_END_DATETIME_TOOL_PARAM_DESCRIPTION
from holmes.plugins.toolsets.utils import (
    process_timestamps_to_int,
    standard_start_datetime_tool_param_description,
    toolset_name_for_one_liner,
)
from holmes.utils.header_rendering import render_env_template
from holmes.utils.pydantic_utils import ToolsetConfig

logger = logging.getLogger(__name__)

DEFAULT_TIME_RANGE_SECONDS = 15 * 60
DEFAULT_ERROR_QUERY = (
    "(level >= 50 OR status >= 500 OR msg:error OR msg:exception OR "
    "msg:failed OR msg:timeout OR msg:panic OR content:error OR "
    "content:exception OR content:failed OR content:timeout OR content:panic)"
)
SENSITIVE_KEY_PARTS = ("password", "secret", "token", "authorization", "cookie")


class AliyunSLSConfig(ToolsetConfig):
    """Credentials and bounds for one Alibaba Cloud SLS project/logstore."""

    endpoint: str = Field(
        title="SLS Endpoint",
        description="Regional SLS endpoint, for example cn-shanghai.log.aliyuncs.com.",
        examples=["cn-shanghai.log.aliyuncs.com"],
    )
    project: str = Field(title="SLS Project", examples=["applog-pyxis"])
    logstore: str = Field(title="SLS Logstore", examples=["prod-application"])
    access_key_id: Optional[str] = Field(
        default=None,
        title="AccessKey ID",
        description="Provide through an environment variable or secret manager; never commit credentials.",
    )
    access_key_secret: Optional[str] = Field(
        default=None,
        title="AccessKey Secret",
        description="Provide through an environment variable or secret manager; never commit credentials.",
    )
    security_token: Optional[str] = Field(default=None, title="Security Token")
    default_time_range_minutes: int = Field(default=15, ge=1, le=1440)
    max_time_range_minutes: int = Field(
        default=1440,
        ge=1,
        le=10080,
        description="Maximum time span accepted by a tool call.",
    )
    max_results: int = Field(default=100, ge=1, le=500)
    timeout_seconds: int = Field(default=10, ge=1, le=120)

    @model_validator(mode="before")
    @classmethod
    def load_credentials_from_environment(cls, values: Any) -> Any:
        if not isinstance(values, dict):
            return values
        values = dict(values)
        for field, env_name in (
            ("access_key_id", "ALIBABA_CLOUD_ACCESS_KEY_ID"),
            ("access_key_secret", "ALIBABA_CLOUD_ACCESS_KEY_SECRET"),
            ("security_token", "ALIBABA_CLOUD_SECURITY_TOKEN"),
        ):
            configured = values.get(field)
            if isinstance(configured, str):
                values[field] = render_env_template(
                    configured, f"AliyunSLSConfig.{field}"
                )
            if not values.get(field):
                values[field] = os.getenv(env_name)
        return values

    @model_validator(mode="after")
    def validate_credentials(self) -> "AliyunSLSConfig":
        if bool(self.access_key_id) != bool(self.access_key_secret):
            raise ValueError(
                "access_key_id and access_key_secret must be provided together"
            )
        if not self.access_key_id or not self.access_key_secret:
            raise ValueError(
                "access_key_id and access_key_secret are required; use environment "
                "variables or a secret manager to provide them"
            )
        if self.default_time_range_minutes > self.max_time_range_minutes:
            raise ValueError(
                "default_time_range_minutes cannot exceed max_time_range_minutes"
            )
        return self


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "[REDACTED]"
            if any(part in key.lower() for part in SENSITIVE_KEY_PARTS)
            else _redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def _serialize_log(log: Any) -> Dict[str, Any]:
    if hasattr(log, "_to_dict"):
        raw = log._to_dict()
    elif isinstance(log, dict):
        raw = log
    else:
        raw = {"message": str(log)}

    result = _redact(raw)
    content = result.get("content") if isinstance(result, dict) else None
    if isinstance(content, str):
        try:
            redacted_content = _redact(json.loads(content))
            result["content_json"] = redacted_content
            result["content"] = json.dumps(
                redacted_content, separators=(",", ":"), ensure_ascii=False
            )
        except (TypeError, ValueError):
            pass
    return result


class AliyunSLSToolset(Toolset):
    """Read-only tools for searching structured logs in Alibaba Cloud SLS."""

    config_classes: ClassVar[list[Type[AliyunSLSConfig]]] = [AliyunSLSConfig]
    _client: Optional[LogClient] = None

    def __init__(self):
        super().__init__(
            name="aliyun-sls",
            enabled=False,
            description=(
                "Read-only search of structured Alibaba Cloud SLS logs, including "
                "error filtering and TraceId/RequestId context lookup."
            ),
            docs_url="https://holmesgpt.dev/data-sources/builtin-toolsets/aliyun-sls/",
            icon_url="https://www.alibabacloud.com/favicon.ico",
            prerequisites=[CallablePrerequisite(callable=self.prerequisites_callable)],
            tools=[],
            tags=[ToolsetTag.CORE],
        )
        self.tools = [
            AliyunSLSQuery(self),
            AliyunSLSErrorQuery(self),
            AliyunSLSTraceContext(self),
        ]
        self._load_llm_instructions_from_file(
            os.path.dirname(__file__), "instructions.jinja2"
        )

    @property
    def sls_config(self) -> AliyunSLSConfig:
        return self.config  # type: ignore[return-value]

    def _new_client(self) -> LogClient:
        config = self.sls_config
        client = LogClient(
            config.endpoint,
            config.access_key_id,
            config.access_key_secret,
            securityToken=config.security_token,
        )
        client.timeout = config.timeout_seconds
        return client

    def _get_client(self) -> LogClient:
        if self._client is None:
            self._client = self._new_client()
        return self._client

    def prerequisites_callable(self, config: Dict[str, Any]) -> Tuple[bool, str]:
        if not config:
            return False, "Missing configuration for aliyun-sls toolset"
        try:
            self.config = AliyunSLSConfig(**config)
            self._client = self._new_client()
            self._client.get_logstore(self.sls_config.project, self.sls_config.logstore)
            return True, (
                f"Connected to SLS project '{self.sls_config.project}', "
                f"logstore '{self.sls_config.logstore}'"
            )
        except LogException as exc:
            return False, self._format_api_error("health check", exc)
        except Exception as exc:
            logger.exception("Aliyun SLS health check failed")
            return False, f"Aliyun SLS health check failed: {exc}"

    def _time_range(self, params: Dict[str, Any]) -> Tuple[int, int]:
        config = self.sls_config
        start, end = process_timestamps_to_int(
            params.get("start_datetime"),
            params.get("end_datetime"),
            default_time_span_seconds=config.default_time_range_minutes * 60,
        )
        if end - start > config.max_time_range_minutes * 60:
            raise ValueError(
                f"time range is {end - start}s, exceeding configured maximum "
                f"of {config.max_time_range_minutes} minutes"
            )
        return start, end

    def search(
        self,
        params: Dict[str, Any],
        query: str,
        *,
        context: Optional[ToolInvokeContext] = None,
    ) -> StructuredToolResult:
        config = self.sls_config
        start, end = self._time_range(params)
        requested_limit = params.get("limit") or config.max_results
        limit = min(int(requested_limit), config.max_results)
        params["limit"] = limit
        request = GetLogsRequest(
            project=config.project,
            logstore=config.logstore,
            fromTime=start,
            toTime=end,
            topic=params.get("topic"),
            query=query or "*",
            line=limit,
            reverse=True,
            power_sql=False,
            accurate_query=True,
        )
        try:
            response = self._get_client().get_logs(request)
            logs = [_serialize_log(log) for log in response.get_logs()]
            data = {
                "project": config.project,
                "logstore": config.logstore,
                "query": query or "*",
                "start_time": start,
                "end_time": end,
                "count": response.get_count(),
                "logs": logs,
            }
            status = (
                StructuredToolResultStatus.SUCCESS
                if logs
                else StructuredToolResultStatus.NO_DATA
            )
            return StructuredToolResult(status=status, data=data, params=params)
        except LogException as exc:
            return StructuredToolResult(
                status=StructuredToolResultStatus.ERROR,
                error=self._format_api_error(
                    "log query", exc, query=query, start=start, end=end
                ),
                params=params,
            )
        except Exception as exc:
            logger.exception("Aliyun SLS log query failed")
            return StructuredToolResult(
                status=StructuredToolResultStatus.ERROR,
                error=(
                    f"Aliyun SLS log query failed for project={config.project}, "
                    f"logstore={config.logstore}, query={query!r}, "
                    f"time_range=[{start}, {end}]: {exc}"
                ),
                params=params,
            )

    def _format_api_error(
        self,
        operation: str,
        exc: Exception,
        *,
        query: Optional[str] = None,
        start: Optional[int] = None,
        end: Optional[int] = None,
    ) -> str:
        config = self.sls_config
        details = (
            f"operation={operation}, project={config.project}, "
            f"logstore={config.logstore}, endpoint={config.endpoint}"
        )
        if query is not None:
            details += f", query={query!r}"
        if start is not None and end is not None:
            details += f", time_range=[{start}, {end}]"
        return f"Aliyun SLS API error ({details}): {exc}"


class _BaseAliyunSLSTool(Tool, ABC):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    def __init__(self, toolset: AliyunSLSToolset, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self._toolset = toolset

    def _invoke_query(self, params: Dict[str, Any], query: str) -> StructuredToolResult:
        try:
            return self._toolset.search(params, query)
        except ValueError as exc:
            return StructuredToolResult(
                status=StructuredToolResultStatus.ERROR,
                error=f"Invalid Aliyun SLS query parameters: {exc}",
                params=params,
            )

    def _common_parameters(self) -> Dict[str, ToolParameter]:
        return {
            "start_datetime": ToolParameter(
                description=standard_start_datetime_tool_param_description(
                    DEFAULT_TIME_RANGE_SECONDS
                ),
                type="string",
                required=False,
            ),
            "end_datetime": ToolParameter(
                description=STANDARD_END_DATETIME_TOOL_PARAM_DESCRIPTION,
                type="string",
                required=False,
            ),
            "limit": ToolParameter(
                description="Maximum results to return; capped by the toolset configuration.",
                type="integer",
                required=False,
            ),
            "topic": ToolParameter(
                description="Optional SLS topic filter.", type="string", required=False
            ),
        }


class AliyunSLSQuery(_BaseAliyunSLSTool):
    def __init__(self, toolset: AliyunSLSToolset):
        super().__init__(
            toolset,
            name="aliyun_sls_search_logs",
            description=(
                "Search structured logs in the configured Alibaba Cloud SLS project/logstore. "
                "Use SLS query syntax and always keep a narrow time range."
            ),
            parameters={
                **self._common_parameters(),
                "query": ToolParameter(
                    description="SLS search query, for example service:ec-saas AND component:domain.",
                    type="string",
                    required=True,
                ),
            },
        )

    def _invoke(
        self, params: Dict[str, Any], context: ToolInvokeContext
    ) -> StructuredToolResult:
        return self._invoke_query(params, params["query"])

    def get_parameterized_one_liner(self, params: Dict) -> str:
        return f"{toolset_name_for_one_liner(self._toolset.name)}: Search logs ({params.get('query', '')})"


class AliyunSLSErrorQuery(_BaseAliyunSLSTool):
    def __init__(self, toolset: AliyunSLSToolset):
        super().__init__(
            toolset,
            name="aliyun_sls_search_errors",
            description=(
                "Search likely error logs in SLS. Filters high log levels, HTTP 5xx statuses, "
                "and common error words; an optional query narrows the result."
            ),
            parameters={
                **self._common_parameters(),
                "query": ToolParameter(
                    description="Optional additional SLS filter, such as service:ec-saas.",
                    type="string",
                    required=False,
                ),
            },
        )

    def _invoke(
        self, params: Dict[str, Any], context: ToolInvokeContext
    ) -> StructuredToolResult:
        query = DEFAULT_ERROR_QUERY
        if params.get("query"):
            query = f"({query}) AND ({params['query']})"
        return self._invoke_query(params, query)

    def get_parameterized_one_liner(self, params: Dict) -> str:
        return f"{toolset_name_for_one_liner(self._toolset.name)}: Search error logs"


def _quoted_field(field: str, value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'{field}:"{escaped}"'


class AliyunSLSTraceContext(_BaseAliyunSLSTool):
    def __init__(self, toolset: AliyunSLSToolset):
        super().__init__(
            toolset,
            name="aliyun_sls_get_trace_context",
            description=(
                "Find all logs sharing a TraceId or RequestId, optionally narrowed by service. "
                "Use this after an error search to reconstruct request context."
            ),
            parameters={
                **self._common_parameters(),
                "trace_id": ToolParameter(
                    description="Exact traceId value from a previously observed log.",
                    type="string",
                    required=False,
                ),
                "request_id": ToolParameter(
                    description="Exact requestId value from a previously observed log.",
                    type="string",
                    required=False,
                ),
                "service": ToolParameter(
                    description="Optional exact service name.",
                    type="string",
                    required=False,
                ),
            },
        )

    def _invoke(
        self, params: Dict[str, Any], context: ToolInvokeContext
    ) -> StructuredToolResult:
        clauses: List[str] = []
        if params.get("trace_id"):
            clauses.append(_quoted_field("traceId", params["trace_id"]))
        if params.get("request_id"):
            clauses.append(_quoted_field("requestId", params["request_id"]))
        if params.get("service"):
            clauses.append(_quoted_field("service", params["service"]))
        if not clauses:
            return StructuredToolResult(
                status=StructuredToolResultStatus.ERROR,
                error="Provide at least one of trace_id or request_id.",
                params=params,
            )
        return self._invoke_query(params, " AND ".join(clauses))

    def get_parameterized_one_liner(self, params: Dict) -> str:
        identity = params.get("trace_id") or params.get("request_id") or "context"
        return f"{toolset_name_for_one_liner(self._toolset.name)}: Trace context ({identity})"
