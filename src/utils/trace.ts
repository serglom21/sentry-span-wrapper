import { 
  spanTimeInputToSeconds,
  SEMANTIC_ATTRIBUTE_SENTRY_OP,
  SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN,
  SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE,
  SEMANTIC_ATTRIBUTE_SENTRY_SOURCE,
} from "@sentry/core";
import { SentrySpanArguments, SpanJSON } from "@sentry/types";
import { NormalizedTraces, TraceContextObject } from "../types";
import { dropUndefinedKeys } from "@sentry/utils";
import { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { getSpanData } from "./spanExporter";

function normalizedSpanForTrace(spans: []) {
  let normalizedSpans = [];
  //console.log(spans)
  let print = 0;
  for (let span of spans) {
    if (print < 2) {
      console.log(span);
      print++;
    }
    try {
      normalizedSpans.push(normalizeSpan(span));
    } catch (error) {
      console.log(error);
    }
  }
  return normalizedSpans;
}

function normalizeSpan(span: ReadableSpan) {
  const { op, description, data, origin = 'manual' } = getSpanData(span);
  const allData = dropUndefinedKeys({
    [SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: span["attributes"][SEMANTIC_ATTRIBUTE_SENTRY_SOURCE],
    [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: span["attributes"][SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN],
    [SEMANTIC_ATTRIBUTE_SENTRY_OP]: span["attributes"][SEMANTIC_ATTRIBUTE_SENTRY_OP],
    [SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE]: span["attributes"][SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE],
    ...data
  });

  let newSpan: SpanJSON = dropUndefinedKeys({
    span_id: span.spanContext().spanId,
    trace_id: span.spanContext().traceId,
    start_timestamp: spanTimeInputToSeconds(span["startTime"]),
    timestamp: spanTimeInputToSeconds(span["endTime"]),
    description: description,
    op,
    origin, 
    data: allData
  })
  return newSpan;
}

export function extractTraceContext(jsonString: any) : TraceContextObject | null {
    const lines = jsonString.split('\n');

    for (const line of lines) {
        try {
          const jsonData = JSON.parse(line);
    
          // Check if the parsed object contains `contexts.trace`
          if (jsonData.contexts && jsonData.contexts.trace) {
            const traceContext = jsonData.contexts.trace;
  
            const spans = jsonData.spans ? jsonData.spans : [];
            const type = jsonData.type;
            return { traceContext, spans, type };
          }
        } catch (error) {
          continue;
        }
      }
    
      return null;
}

export function replaceTraceID(event: string, trace_id: number, parent_span_id: number) {
    const lines = event.split('\n');
    let jsonString = '';
    for (const line of lines) {
      const jsonData = JSON.parse(line);
      if (jsonData.trace) {
        jsonData.trace.trace_id = trace_id;
      }

      if (jsonData.contexts && jsonData.contexts.trace) {
        jsonData.contexts.trace.trace_id = trace_id;
        jsonData.contexts.trace.span_id = parent_span_id;
      }

      if (jsonData.spans) {
        for (let span of jsonData.spans) {
          span.trace_id = trace_id;
          span.parent_span_id = parent_span_id;
        }
      }

      jsonString +=  JSON.stringify(jsonData) + '\n';
    }

    return jsonString;
}

export function correctSpansForTrace(event: any, spans: [], numOfSpansExceeded: number) : NormalizedTraces {
    let normalizedSpans = normalizedSpanForTrace(spans);
    const lines = event.split('\n');
    let newTrace = '';
    let currentTrace = '';
    for (let line of lines) {
      const jsonData = JSON.parse(line);
      if (!jsonData.contexts) {
        if (jsonData.event_id) {
          delete jsonData.event_id;
          line = JSON.stringify(jsonData)
        }

        newTrace += `${line}\n`;
        currentTrace += `${line}\n`
      } else {
        let propertiesNewJSON : any = {}
        let propertiesCurrentJSON : any = {}
        for (const property in jsonData){
          if (property == "spans") {
            let spansForCurrentTrace = normalizedSpans.slice(0, numOfSpansExceeded);
            let spansForNewTrace = normalizedSpans.slice(numOfSpansExceeded);
            propertiesNewJSON[property] = spansForNewTrace;
            propertiesCurrentJSON[property] = spansForCurrentTrace;
          } else {
            propertiesNewJSON[property] = jsonData[property];
            propertiesCurrentJSON[property] = jsonData[property];
          }
        }
        newTrace += JSON.stringify(propertiesNewJSON);
        currentTrace += JSON.stringify(propertiesCurrentJSON);
      }
    }
    return { newTrace, currentTrace }
  }
