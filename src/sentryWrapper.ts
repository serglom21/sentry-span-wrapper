import { NodeClient, init, getActiveSpan } from "@sentry/node";
import { NodeClientOptions } from "@sentry/node/build/types/types";
import { TransportWrapper } from "./transportWrapper";

export class SentryWrapper {
    private traceMap : Map<string, []>;
    private client : NodeClient | undefined

    constructor(options: NodeClientOptions){
        const transportWrapper = new TransportWrapper(this);
        this.traceMap = new Map();
        this.client = init({
            ...options,
            transport: transportWrapper.getTransport()
        });
        this.client?.on("spanEnd", (span) => {
            this.onSpanEnd(span)
        })
    }

    public onSpanEnd(span: any){
        const activeSpan = getActiveSpan();
        const traceMap = this.getTraceMap();

        if (activeSpan) {
            const context = activeSpan.spanContext();
            const traceID = context.traceId;

            if (traceID) {
                let spans = [];
                if (traceMap.has(traceID)) {
                    spans = traceMap.get(traceID);
                }  
                
                spans.push(span);
                traceMap.set(traceID, spans);
            }
        }
    }   

    public getTraceMap(): Map<any, any> {
        return this.traceMap;
    }

    public getSpansByTraceID(traceID: string) : [] {
        for (const [key, value] of this.traceMap.entries()) {
            if (key == traceID) {
                return value;
            }
        }
        return [];
    }
}
