import { NodeClient, init, getActiveSpan } from "@sentry/node";
import { NodeClientOptions } from "@sentry/node/build/types/types";
import { TransportWrapper } from "./transportWrapper";

export class SentryWrapper {
    private spanMap : Map<string, []>;
    private client : NodeClient | undefined

    constructor(options: NodeClientOptions){
        const transportWrapper = new TransportWrapper(this);
        this.spanMap = new Map();
        this.client = init({
            ...options,
            transport: transportWrapper.getTransport()
        });
        this.client?.on("spanEnd", (span) => {
            this.onSpanEnd(span)
        })
    }

    public onSpanEnd(span: any){
        const spanMap = this.getSpanMap();
        if (span) {
            const parentID = span["parentSpanId"] ?? null;
            if (parentID) {
                let spans = [];
                if (spanMap.has(parentID)) {
                    spans = spanMap.get(parentID);
                }

                spans.push(span);
                this.setMapValue(parentID, spans);
            }
        }
    }   

    public getSpanMap(): Map<any, any> {
        return this.spanMap;
    }

    public setMapValue(key: any, value: any) {
        this.spanMap.set(key, value);
    }

    public getChildSpans(parentID: string) : [] {
        for (const [key, value] of this.spanMap.entries()) {
            if (key == parentID) {
                return value;
            }
        }
        return [];
    }
}
