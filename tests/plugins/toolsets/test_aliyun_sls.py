import pytest

from holmes.core.tools import StructuredToolResultStatus
from holmes.plugins.toolsets.aliyun_sls.aliyun_sls import (
    AliyunSLSConfig,
    AliyunSLSToolset,
    DEFAULT_ERROR_QUERY,
)


class FakeLog:
    def __init__(self, data):
        self.data = data

    def _to_dict(self):
        return self.data


class FakeResponse:
    def __init__(self, logs):
        self.logs = logs

    def get_logs(self):
        return [FakeLog(log) for log in self.logs]

    def get_count(self):
        return len(self.logs)


class FakeClient:
    def __init__(self, logs=None):
        self.logs = logs or []
        self.requests = []
        self.logstore_checks = []
        self.timeout = None

    def get_logstore(self, project, logstore):
        self.logstore_checks.append((project, logstore))

    def get_logs(self, request):
        self.requests.append(request)
        return FakeResponse(self.logs)


def configured_toolset(logs=None):
    toolset = AliyunSLSToolset()
    toolset.config = AliyunSLSConfig(
        endpoint="cn-shanghai.log.aliyuncs.com",
        project="demo-project",
        logstore="application",
        access_key_id="id",
        access_key_secret="secret",
    )
    client = FakeClient(logs)
    toolset._client = client
    return toolset, client


def get_tool(toolset, name):
    return next(tool for tool in toolset.tools if tool.name == name)


class TestAliyunSLSConfig:
    def test_credentials_must_be_a_pair(self):
        with pytest.raises(ValueError, match="provided together"):
            AliyunSLSConfig(
                endpoint="endpoint",
                project="project",
                logstore="logstore",
                access_key_id="id",
            )

    def test_default_bounds(self):
        config = AliyunSLSConfig(
            endpoint="endpoint",
            project="project",
            logstore="logstore",
            access_key_id="id",
            access_key_secret="secret",
        )
        assert config.default_time_range_minutes == 15
        assert config.max_results == 100


class TestAliyunSLSTools:
    def test_search_errors_uses_server_side_error_filter(self):
        toolset, client = configured_toolset(
            [
                {
                    "__time__": "1794818108",
                    "level": "50",
                    "status": "500",
                    "content": '{"password":"do-not-return"}',
                }
            ]
        )

        result = get_tool(toolset, "aliyun_sls_search_errors")._invoke({}, None)

        assert result.status == StructuredToolResultStatus.SUCCESS
        assert client.requests[0].query == DEFAULT_ERROR_QUERY
        assert result.data["logs"][0]["content_json"]["password"] == "[REDACTED]"
        assert "do-not-return" not in result.data["logs"][0]["content"]

    def test_trace_context_requires_identity_and_quotes_values(self):
        toolset, client = configured_toolset([])
        tool = get_tool(toolset, "aliyun_sls_get_trace_context")

        missing = tool._invoke({}, None)
        assert missing.status == StructuredToolResultStatus.ERROR
        assert "trace_id or request_id" in missing.error

        result = tool._invoke({"trace_id": 'trace"-1', "service": "ec-saas"}, None)
        assert result.status == StructuredToolResultStatus.NO_DATA
        assert client.requests[0].query == 'traceId:"trace\\"-1" AND service:"ec-saas"'

    def test_time_range_is_bounded(self):
        toolset, _ = configured_toolset([])
        toolset.config = toolset.sls_config.model_copy(
            update={"max_time_range_minutes": 1}
        )
        result = get_tool(toolset, "aliyun_sls_search_logs")._invoke(
            {"query": "service:ec-saas", "start_datetime": "-120", "end_datetime": "0"},
            None,
        )
        assert result.status == StructuredToolResultStatus.ERROR
        assert "exceeding configured maximum" in result.error

    def test_health_check_reports_project_and_logstore(self, monkeypatch):
        toolset = AliyunSLSToolset()
        client = FakeClient()
        monkeypatch.setattr(toolset, "_new_client", lambda: client)

        ok, message = toolset.prerequisites_callable(
            {
                "endpoint": "cn-shanghai.log.aliyuncs.com",
                "project": "demo-project",
                "logstore": "application",
                "access_key_id": "id",
                "access_key_secret": "secret",
            }
        )

        assert ok is True
        assert "demo-project" in message
        assert client.logstore_checks == [("demo-project", "application")]
