# Alibaba Cloud SLS

Connect HolmesGPT to [Alibaba Cloud Simple Log Service (SLS)](https://www.alibabacloud.com/product/log-service) for read-only investigation of structured application logs. The toolset supports targeted searches, error filtering, and TraceId/RequestId context lookup.

## Prerequisites

- An SLS project and logstore containing indexed fields used by your application.
- An AccessKey pair for a RAM principal with read-only access to the project and logstore (`log:Get*` and `log:List*` as required by the health check).
- A regional endpoint such as `cn-shanghai.log.aliyuncs.com`.

Inject the AccessKey pair through environment variables or your secret manager; never commit credentials.

## Configuration

```yaml-toolset-config
toolsets:
  aliyun-sls:
    enabled: true
    config:
      endpoint: cn-shanghai.log.aliyuncs.com
      project: applog-pyxis
      logstore: prod-tob-ec-saas-domain
      access_key_id: "{{ env.ALIBABA_CLOUD_ACCESS_KEY_ID }}"
      access_key_secret: "{{ env.ALIBABA_CLOUD_ACCESS_KEY_SECRET }}"
      default_time_range_minutes: 15
      max_time_range_minutes: 1440
      max_results: 100
      timeout_seconds: 10
```

`security_token` may be supplied for temporary STS credentials. `access_key_id` and `access_key_secret` must be supplied together. The toolset never writes to SLS.

## Investigation workflow

1. Start with `aliyun_sls_search_errors` and a narrow time range.
2. Use an exact `trace_id` or `request_id` returned by the first query with `aliyun_sls_get_trace_context`.
3. Use `aliyun_sls_search_logs` to inspect service, component, status, or message fields.

The error search detects `level >= 50`, HTTP `status >= 500`, and common error words such as `error`, `exception`, `failed`, `timeout`, and `panic`. The sample request-completed log with `level:30` and `status:200` is therefore treated as a successful informational log.

## Multiple instances

```multi-instance
toolset: aliyun-sls
name: Alibaba Cloud SLS
config: |
  endpoint: cn-shanghai.log.aliyuncs.com
  project: applog-pyxis
  logstore: prod-tob-ec-saas-domain
  access_key_id: "{{ env.ALIBABA_CLOUD_ACCESS_KEY_ID }}"
  access_key_secret: "{{ env.ALIBABA_CLOUD_ACCESS_KEY_SECRET }}"
```

## Capabilities

| Tool | Purpose |
| --- | --- |
| `aliyun_sls_search_logs` | Search indexed SLS fields and text within a bounded time range |
| `aliyun_sls_search_errors` | Find likely application errors using level, status, and common error terms |
| `aliyun_sls_get_trace_context` | Retrieve logs sharing an exact TraceId or RequestId |
