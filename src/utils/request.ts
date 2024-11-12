export function sendEventPayload(url: string, requestOptions: object){
    return fetch(url, requestOptions).then(response => {
      return {
          statusCode: response.status,
          headers: {
            'x-sentry-rate-limits': response.headers.get('X-Sentry-Rate-Limits'),
            'retry-after': response.headers.get('Retry-After'),
          },
      };
  })
}