import { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { Attributes, AttributeValue, Span, SpanKind } from '@opentelemetry/api';
import { ATTR_HTTP_REQUEST_METHOD, ATTR_HTTP_RESPONSE_STATUS_CODE, ATTR_HTTP_ROUTE, ATTR_URL_FULL, SEMATTRS_DB_STATEMENT, SEMATTRS_DB_SYSTEM, SEMATTRS_FAAS_TRIGGER, SEMATTRS_HTTP_METHOD, SEMATTRS_HTTP_TARGET, SEMATTRS_HTTP_URL, SEMATTRS_MESSAGING_SYSTEM, SEMATTRS_RPC_SERVICE  } from '@opentelemetry/semantic-conventions';
import { AbstractSpan } from "@sentry/node/build/types/types";
import { SanitizedRequestData, SpanAttributes, SpanOrigin, TransactionSource } from "@sentry/types";
import { getSanitizedUrlString, parseUrl, stripUrlQueryAndFragment } from "@sentry/utils";
import { SEMANTIC_ATTRIBUTE_SENTRY_OP, SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN, SEMANTIC_ATTRIBUTE_SENTRY_SOURCE } from "@sentry/core";

interface SpanDescription {
    op: string | undefined;
    description: string;
    source: TransactionSource;
    data?: Record<string, string | undefined>;
}

export const SEMANTIC_ATTRIBUTE_SENTRY_GRAPHQL_OPERATION = 'sentry.graphql.operation';

function getData(span: ReadableSpan): Record<string, unknown> {
    const attributes = span.attributes;
    const data: Record<string, unknown> = {};
  
    if (span.kind !== SpanKind.INTERNAL) {
      data['otel.kind'] = SpanKind[span.kind];
    }
  
    // eslint-disable-next-line deprecation/deprecation
    const maybeHttpStatusCodeAttribute = attributes["http.status_code"];
    if (maybeHttpStatusCodeAttribute) {
      data[ATTR_HTTP_RESPONSE_STATUS_CODE] = maybeHttpStatusCodeAttribute as string;
    }

    const requestData = getRequestSpanData(span);
  
    if (requestData.url) {
      data.url = requestData.url;
    }
  
    if (requestData['http.query']) {
      data['http.query'] = requestData['http.query'].slice(1);
    }
    if (requestData['http.fragment']) {
      data['http.fragment'] = requestData['http.fragment'].slice(1);
    }
  
    return data;
}

export function getSpanData(span: ReadableSpan): {
    data: Record<string, unknown>;
    op?: string;
    description: string;
    source?: TransactionSource;
    origin?: SpanOrigin;
    } {
    const { op: definedOp, source: definedSource, origin } = parseSpan(span);
    const { op: inferredOp, description, source: inferredSource, data: inferredData } = parseSpanDescription(span);

    const op = definedOp || inferredOp;
    const source = definedSource || inferredSource;

    const data = { ...inferredData, ...getData(span) };

    return {
        op,
        description,
        source,
        origin,
        data,
    };
}

export function parseSpanDescription(span: AbstractSpan): SpanDescription {
    const attributes = spanHasAttributes(span) ? span.attributes : {};
    const name = spanHasName(span) ? span.name : '<unknown>';
    const kind = getSpanKind(span);
  
    return inferSpanData(name, attributes, kind);
}

export function spanHasName<SpanType extends AbstractSpan>(span: SpanType): span is SpanType & { name: string } {
    const castSpan = span as ReadableSpan;
    return !!castSpan.name;
}

export function getSpanKind(span: AbstractSpan): SpanKind {
    if (spanHasKind(span)) {
      return span.kind;
    }
  
    return SpanKind.INTERNAL;
}

export function spanHasKind<SpanType extends AbstractSpan>(span: SpanType): span is SpanType & { kind: SpanKind } {
    const castSpan = span as ReadableSpan;
    return typeof castSpan.kind === 'number';
  }

export function getRequestSpanData(span: Span | ReadableSpan): Partial<SanitizedRequestData> {
    // The base `Span` type has no `attributes`, so we need to guard here against that
    if (!spanHasAttributes(span)) {
      return {};
    }
  
    // eslint-disable-next-line deprecation/deprecation
    const maybeUrlAttribute = (span.attributes[ATTR_URL_FULL] || span.attributes[SEMATTRS_HTTP_URL]) as
      | string
      | undefined;
  
    const data: Partial<SanitizedRequestData> = {
      url: maybeUrlAttribute,
      // eslint-disable-next-line deprecation/deprecation
      'http.method': (span.attributes[ATTR_HTTP_REQUEST_METHOD] || span.attributes[SEMATTRS_HTTP_METHOD]) as
        | string
        | undefined,
    };
  
    // Default to GET if URL is set but method is not
    if (!data['http.method'] && data.url) {
      data['http.method'] = 'GET';
    }
  
    try {
      if (typeof maybeUrlAttribute === 'string') {
        const url = parseUrl(maybeUrlAttribute);
  
        data.url = getSanitizedUrlString(url);
  
        if (url.search) {
          data['http.query'] = url.search;
        }
        if (url.hash) {
          data['http.fragment'] = url.hash;
        }
      }
    } catch {
      // ignore
    }
  
    return data;
}

export function spanHasAttributes<SpanType extends AbstractSpan>(
    span: SpanType,
  ): span is SpanType & { attributes: ReadableSpan['attributes'] } {
    const castSpan = span as ReadableSpan;
    return !!castSpan.attributes && typeof castSpan.attributes === 'object';
  }

function parseSpan(span: ReadableSpan): { op?: string; origin?: SpanOrigin; source?: TransactionSource } {
    const attributes = span.attributes;
  
    const origin = attributes[SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN] as SpanOrigin | undefined;
    const op = attributes[SEMANTIC_ATTRIBUTE_SENTRY_OP] as string | undefined;
    const source = attributes[SEMANTIC_ATTRIBUTE_SENTRY_SOURCE] as TransactionSource | undefined;
  
    return { origin, op, source };
  }

export function inferSpanData(name: string, attributes: SpanAttributes, kind: SpanKind): SpanDescription {
    // if http.method exists, this is an http request span
    // eslint-disable-next-line deprecation/deprecation
    const httpMethod = attributes[ATTR_HTTP_REQUEST_METHOD] || attributes[SEMATTRS_HTTP_METHOD];
    if (httpMethod) {
      return descriptionForHttpMethod({ attributes, name, kind }, httpMethod);
    }
  
    // eslint-disable-next-line deprecation/deprecation
    const dbSystem = attributes[SEMATTRS_DB_SYSTEM];
    const opIsCache =
      typeof attributes[SEMANTIC_ATTRIBUTE_SENTRY_OP] === 'string' &&
      attributes[SEMANTIC_ATTRIBUTE_SENTRY_OP].startsWith('cache.');
  
    // If db.type exists then this is a database call span
    // If the Redis DB is used as a cache, the span description should not be changed
    if (dbSystem && !opIsCache) {
      return descriptionForDbSystem({ attributes, name });
    }
  
    // If rpc.service exists then this is a rpc call span.
    // eslint-disable-next-line deprecation/deprecation
    const rpcService = attributes[SEMATTRS_RPC_SERVICE];
    if (rpcService) {
      return {
        op: 'rpc',
        description: name,
        source: 'route',
      };
    }
  
    // If messaging.system exists then this is a messaging system span.
    // eslint-disable-next-line deprecation/deprecation
    const messagingSystem = attributes[SEMATTRS_MESSAGING_SYSTEM];
    if (messagingSystem) {
      return {
        op: 'message',
        description: name,
        source: 'route',
      };
    }
  
    // If faas.trigger exists then this is a function as a service span.
    // eslint-disable-next-line deprecation/deprecation
    const faasTrigger = attributes[SEMATTRS_FAAS_TRIGGER];
    if (faasTrigger) {
      return { op: faasTrigger.toString(), description: name, source: 'route' };
    }
  
    return { op: undefined, description: name, source: 'custom' };
}

function descriptionForDbSystem({ attributes, name }: { attributes: Attributes; name: string }): SpanDescription {
    // Use DB statement (Ex "SELECT * FROM table") if possible as description.
    // eslint-disable-next-line deprecation/deprecation
    const statement = attributes[SEMATTRS_DB_STATEMENT];
  
    const description = statement ? statement.toString() : name;
  
    return { op: 'db', description, source: 'task' };
  }
  
export function descriptionForHttpMethod(
    { name, kind, attributes }: { name: string; attributes: Attributes; kind: SpanKind },
    httpMethod: AttributeValue,
  ): SpanDescription {
    const opParts = ['http'];
  
    switch (kind) {
      case SpanKind.CLIENT:
        opParts.push('client');
        break;
      case SpanKind.SERVER:
        opParts.push('server');
        break;
    }
  
    // Spans for HTTP requests we have determined to be prefetch requests will have a `.prefetch` postfix in the op
    if (attributes['sentry.http.prefetch']) {
      opParts.push('prefetch');
    }
  
    const { urlPath, url, query, fragment, hasRoute } = getSanitizedUrl(attributes, kind);
  
    if (!urlPath) {
      return { op: opParts.join('.'), description: name, source: 'custom' };
    }
  
    const graphqlOperationsAttribute = attributes[SEMANTIC_ATTRIBUTE_SENTRY_GRAPHQL_OPERATION];
  
    // Ex. GET /api/users
    const baseDescription = `${httpMethod} ${urlPath}`;
  
    // When the http span has a graphql operation, append it to the description
    // We add these in the graphqlIntegration
    const description = graphqlOperationsAttribute
      ? `${baseDescription} (${getGraphqlOperationNamesFromAttribute(graphqlOperationsAttribute)})`
      : baseDescription;
  
    // If `httpPath` is a root path, then we can categorize the transaction source as route.
    const source: TransactionSource = hasRoute || urlPath === '/' ? 'route' : 'url';
  
    const data: Record<string, string> = {};
  
    if (url) {
      data.url = url;
    }
    if (query) {
      data['http.query'] = query;
    }
    if (fragment) {
      data['http.fragment'] = fragment;
    }
  
    // If the span kind is neither client nor server, we use the original name
    // this infers that somebody manually started this span, in which case we don't want to overwrite the name
    const isClientOrServerKind = kind === SpanKind.CLIENT || kind === SpanKind.SERVER;
  
    // If the span is an auto-span (=it comes from one of our instrumentations),
    // we always want to infer the name
    // this is necessary because some of the auto-instrumentation we use uses kind=INTERNAL
    const origin = attributes[SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN] || 'manual';
    const isManualSpan = !`${origin}`.startsWith('auto');
  
    const useInferredDescription = isClientOrServerKind || !isManualSpan;
  
    return {
      op: opParts.join('.'),
      description: useInferredDescription ? description : name,
      source: useInferredDescription ? source : 'custom',
      data,
    };
  }

  export function getSanitizedUrl(
    attributes: Attributes,
    kind: SpanKind,
  ): {
    url: string | undefined;
    urlPath: string | undefined;
    query: string | undefined;
    fragment: string | undefined;
    hasRoute: boolean;
  } {
    // This is the relative path of the URL, e.g. /sub
    // eslint-disable-next-line deprecation/deprecation
    const httpTarget = attributes[SEMATTRS_HTTP_TARGET];
    // This is the full URL, including host & query params etc., e.g. https://example.com/sub?foo=bar
    // eslint-disable-next-line deprecation/deprecation
    const httpUrl = attributes[SEMATTRS_HTTP_URL] || attributes[ATTR_URL_FULL];
    // This is the normalized route name - may not always be available!
    const httpRoute = attributes[ATTR_HTTP_ROUTE];
  
    const parsedUrl = typeof httpUrl === 'string' ? parseUrl(httpUrl) : undefined;
    const url = parsedUrl ? getSanitizedUrlString(parsedUrl) : undefined;
    const query = parsedUrl && parsedUrl.search ? parsedUrl.search : undefined;
    const fragment = parsedUrl && parsedUrl.hash ? parsedUrl.hash : undefined;
  
    if (typeof httpRoute === 'string') {
      return { urlPath: httpRoute, url, query, fragment, hasRoute: true };
    }
  
    if (kind === SpanKind.SERVER && typeof httpTarget === 'string') {
      return { urlPath: stripUrlQueryAndFragment(httpTarget), url, query, fragment, hasRoute: false };
    }
  
    if (parsedUrl) {
      return { urlPath: url, url, query, fragment, hasRoute: false };
    }
  
    // fall back to target even for client spans, if no URL is present
    if (typeof httpTarget === 'string') {
      return { urlPath: stripUrlQueryAndFragment(httpTarget), url, query, fragment, hasRoute: false };
    }
  
    return { urlPath: undefined, url, query, fragment, hasRoute: false };
  }

  function getGraphqlOperationNamesFromAttribute(attr: AttributeValue): string {
    if (Array.isArray(attr)) {
      const sorted = attr.slice().sort();
  
      // Up to 5 items, we just add all of them
      if (sorted.length <= 5) {
        return sorted.join(', ');
      } else {
        // Else, we add the first 5 and the diff of other operations
        return `${sorted.slice(0, 5).join(', ')}, +${sorted.length - 5}`;
      }
    }
  
    return `${attr}`;
  }
  
