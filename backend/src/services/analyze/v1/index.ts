import mlog from "logger"
import { v4 as uuidv4 } from "uuid"
import { ApiTrace, ApiEndpoint, Alert } from "models"
import { SpecService } from "services/spec"
import { RedisClient } from "utils/redis"
import {
  TRACE_IN_MEM_EXPIRE_SEC,
  TRACE_IN_MEM_RETENTION_COUNT,
  TRACE_PATH_IN_MEM_RETENTION_COUNT,
} from "~/constants"
import { QueryRunner } from "typeorm"
import { QueuedApiTrace } from "@common/types"
import { endpointUpdateDates } from "utils"
import { MetloContext } from "types"
import { getQB, insertValuesBuilder } from "services/database/utils"
import { sendWebhookRequests } from "services/webhook"
import { findDataFieldsToSave } from "services/data-field/analyze"
import { createDataFieldAlerts } from "services/alert/sensitive-data"
import { createNewEndpointAlert } from "services/alert/new-endpoint"
import { getSensitiveDataMap } from "services/scanner/analyze-trace"
import { getCombinedDataClassesCached } from "services/data-classes"
import { getGlobalFullTraceCaptureCached } from "services/metlo-config"
import { shouldUpdateEndpoint, updateDataFields } from "analyze-traces"

export const analyze = async (
  ctx: MetloContext,
  trace: QueuedApiTrace,
  apiEndpoint: ApiEndpoint,
  queryRunner: QueryRunner,
  newEndpoint: boolean,
  skipDataFields: boolean,
  hasValidLicense: boolean,
) => {
  const traceUUID = uuidv4()
  mlog.debug(`Analyzing Trace: ${traceUUID}`)
  const prevRiskScore = apiEndpoint.riskScore
  const prevLastActive = apiEndpoint.lastActive
  endpointUpdateDates(trace.createdAt, apiEndpoint)
  mlog.debug(`Analyzing Trace - Updated Dates: ${traceUUID}`)

  trace.requestParameters = trace.requestParameters.map(e => ({
    name: (e.name || "").split("[")[0],
    value: e.value,
  }))

  if (Array.isArray(trace.requestBody)) {
    trace.requestBody = JSON.stringify(trace.requestBody)
  }
  if (Array.isArray(trace.responseBody)) {
    trace.responseBody = JSON.stringify(trace.responseBody)
  }

  const startDataClasses = performance.now()
  const dataClasses = await getCombinedDataClassesCached(ctx)
  mlog.time("analyzer.get_data_classes", performance.now() - startDataClasses)
  mlog.debug(`Analyzing Trace - Got Data Classes: ${traceUUID}`)

  const start1 = performance.now()
  const dataFields = skipDataFields
    ? { dataFields: [], mapDataFields: [] }
    : findDataFieldsToSave(ctx, trace, apiEndpoint, dataClasses)
  mlog.time("analyzer.find_data_fields", performance.now() - start1)
  mlog.debug(`Analyzing Trace - Found Datafields: ${traceUUID}`)

  const startRedact = performance.now()
  const globalFullTraceCapture = await getGlobalFullTraceCaptureCached(ctx)
  const redact = !(
    globalFullTraceCapture || apiEndpoint.fullTraceCaptureEnabled
  )
  mlog.time("analyzer.find_should_redact", performance.now() - startRedact)
  mlog.debug(`Analyzing Trace - Found should redact: ${traceUUID}`)

  const start2 = performance.now()
  let alerts = await SpecService.findOpenApiSpecDiff(
    ctx,
    trace,
    apiEndpoint,
    queryRunner,
    redact,
  )
  mlog.time("analyzer.find_openapi_spec_diff", performance.now() - start2)
  mlog.debug(`Analyzing Trace - Found OpenAPI Spec Diffs: ${traceUUID}`)

  const start3 = performance.now()
  const dataFieldAlerts = await createDataFieldAlerts(
    ctx,
    dataFields.dataFields,
    apiEndpoint.uuid,
    trace,
    queryRunner,
    redact,
  )
  alerts = alerts.concat(dataFieldAlerts)
  mlog.time("analyzer.create_data_field_alerts", performance.now() - start3)
  mlog.debug(`Analyzing Trace - Created Data Field Alerts: ${traceUUID}`)

  if (newEndpoint) {
    const newEndpointAlert = createNewEndpointAlert(
      apiEndpoint,
      trace.createdAt,
    )
    alerts = alerts.concat(newEndpointAlert)
  }

  const startSensitiveDataPopulate = performance.now()
  let filteredApiTrace = {
    ...trace,
    uuid: traceUUID,
    redacted: false,
    apiEndpointUuid: apiEndpoint.uuid,
  } as ApiTrace
  const sensitiveDataMap = getSensitiveDataMap(
    dataClasses,
    filteredApiTrace,
    apiEndpoint.path,
    dataFields.mapDataFields,
  )

  if (redact) {
    filteredApiTrace.redacted = true
    filteredApiTrace.requestParameters = []
    filteredApiTrace.requestHeaders = []
    filteredApiTrace.responseHeaders = []
    filteredApiTrace.requestBody = ""
    filteredApiTrace.responseBody = ""
  }
  mlog.time(
    "analyzer.sensitive_data_populate",
    performance.now() - startSensitiveDataPopulate,
  )
  mlog.debug(`Analyzing Trace - Populated Sensitive Data: ${traceUUID}`)

  const startTraceRedis = performance.now()
  const endpointTraceKey = `endpointTraces:e#${apiEndpoint.uuid}`
  await RedisClient.pushToListPipeline(
    ctx,
    endpointTraceKey,
    [
      JSON.stringify({
        ...filteredApiTrace,
        sensitiveDataMap,
      }),
    ],
    TRACE_IN_MEM_RETENTION_COUNT,
    TRACE_IN_MEM_EXPIRE_SEC,
  )

  if (!apiEndpoint.userSet) {
    const endpointPathKey = `endpointPaths:e#${apiEndpoint.uuid}`
    await RedisClient.pushToListPipeline(
      ctx,
      endpointPathKey,
      [filteredApiTrace.path],
      TRACE_PATH_IN_MEM_RETENTION_COUNT,
      TRACE_IN_MEM_EXPIRE_SEC,
    )
  }

  mlog.time(
    "analyzer.insert_api_trace_redis",
    performance.now() - startTraceRedis,
  )
  mlog.debug(`Analyzing Trace - Inserted API Trace to Redis: ${traceUUID}`)

  const start8 = performance.now()
  if (shouldUpdateEndpoint(prevRiskScore, prevLastActive, apiEndpoint)) {
    await getQB(ctx, queryRunner)
      .update(ApiEndpoint)
      .set({
        firstDetected: apiEndpoint.firstDetected,
        lastActive: apiEndpoint.lastActive,
        riskScore: apiEndpoint.riskScore,
      })
      .andWhere("uuid = :id", { id: apiEndpoint.uuid })
      .execute()
  }
  mlog.time("analyzer.update_api_endpoint_query", performance.now() - start8)
  mlog.debug(`Analyzing Trace - Updated API Endpoint: ${traceUUID}`)

  const startUpdateDataFields = performance.now()
  await updateDataFields(ctx, dataFields.dataFields, queryRunner)
  mlog.time(
    "analyzer.update_data_fields_query",
    performance.now() - startUpdateDataFields,
  )
  mlog.debug(`Analyzing Trace - Updated Data Fields: ${traceUUID}`)

  const start7 = performance.now()
  await insertValuesBuilder(ctx, queryRunner, Alert, alerts)
    .orIgnore()
    .execute()
  mlog.time("analyzer.insert_alerts_query", performance.now() - start7)
  mlog.debug(`Analyzing Trace - Inserted Alerts: ${traceUUID}`)

  const start9 = performance.now()
  await sendWebhookRequests(ctx, alerts, apiEndpoint)
  mlog.time("analyzer.sent_webhook_requests", performance.now() - start9)
  mlog.debug(`Analyzing Trace - Sent Webhook Requests: ${traceUUID}`)
}
