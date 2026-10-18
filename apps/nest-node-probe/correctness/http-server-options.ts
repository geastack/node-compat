import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { env } from 'node:process'

class AppRequest extends IncomingMessage {
  params: { [name: string]: string } = {}

  get path(): string {
    const url = this.url ?? '/'
    const query = url.indexOf('?')
    return query === -1 ? url : url.slice(0, query)
  }
}

class AppResponse<Request extends IncomingMessage = AppRequest> extends ServerResponse<Request> {
  sendText(text: string): void {
    this.setHeader('content-type', 'text/plain; charset=utf-8')
    this.end(text)
  }
}

const server = createServer({ IncomingMessage: AppRequest, ServerResponse: AppResponse }, (incoming: IncomingMessage, outgoing: ServerResponse) => {
  const req = incoming as AppRequest
  const res = outgoing as AppResponse
  req.params = { path: req.path }
  const lines = [
    `request ${req instanceof AppRequest} ${req instanceof IncomingMessage}`,
    `response ${res instanceof AppResponse} ${res instanceof ServerResponse}`,
    `req ${res.req === req} ${res.req.params.path}`,
    `method ${req.method} url ${req.url ?? ''} path ${req.path}`,
    `headersSent ${res.headersSent}`
  ]
  res.sendText(lines.join('\n') + '\n')
})

const PORT = Number(env.PORT ?? '3316')
server.listen(PORT, () => {
  console.log(`http-server-options listening on http://127.0.0.1:${PORT}`)
})
