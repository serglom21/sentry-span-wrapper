import { SpanJSON } from "@sentry/types";

export interface TraceContextObject {
    traceContext: {
        trace_id : string,
        span_id : string,
    },
    spans: Array<SpanJSON>,
    type: string | null
}

export interface NormalizedTraces {
    newTrace: string,
    currentTrace: string
}