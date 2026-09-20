const baseUrl = new URL(process.env.GEA_TODO_BASE_URL ?? 'http://127.0.0.1:3000')
const requestTimeoutMs = 10_000
const createdTitle = 'full-stack correctness: created'
const updatedTitle = 'full-stack correctness: updated'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function request(path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    signal: AbortSignal.timeout(requestTimeoutMs)
  })
  const body = await response.text()
  return { response, body }
}

function assertStatus(exchange, expected, label) {
  if (exchange.response.status === expected) return
  const body = exchange.body.slice(0, 240)
  throw new Error(
    `${label} returned HTTP ${exchange.response.status}, expected ${expected}; body=${JSON.stringify(body)}`
  )
}

function parseJson(exchange, label) {
  assert(
    exchange.response.headers.get('content-type')?.includes('application/json') === true,
    `${label} did not return application/json`
  )
  try {
    return JSON.parse(exchange.body)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} returned invalid JSON: ${detail}`)
  }
}

function isTodo(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.id === 'string' &&
    /^[0-9a-f]{24}$/.test(value.id) &&
    typeof value.title === 'string' &&
    typeof value.completed === 'boolean' &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === 'string' &&
    Number.isFinite(Date.parse(value.updatedAt))
  )
}

function assertTodo(value, expected, label) {
  assert(isTodo(value), `${label} did not return a complete todo body`)
  assert(value.id === expected.id, `${label} returned the wrong id`)
  assert(value.title === expected.title, `${label} returned the wrong title`)
  assert(value.completed === expected.completed, `${label} returned the wrong completed value`)
}

function extractAssetPath(html, tagName, attributeName) {
  const tags = html.match(new RegExp(`<${tagName}\\b[^>]*>`, 'gi')) ?? []
  const tag =
    tagName === 'link'
      ? tags.find((candidate) => /\brel="stylesheet"/i.test(candidate))
      : tags.find((candidate) => /\btype="module"/i.test(candidate))
  if (tag === undefined) throw new Error(`GET / did not contain a ${tagName} asset tag`)
  const value = tag.match(new RegExp(`\\b${attributeName}="([^"]+)"`, 'i'))?.[1]
  if (value === undefined) throw new Error(`GET / ${tagName} tag did not contain ${attributeName}`)
  const assetUrl = new URL(value, baseUrl)
  assert(assetUrl.origin === baseUrl.origin, `GET / referenced an external ${tagName} asset`)
  assert(assetUrl.pathname.startsWith('/assets/'), `GET / referenced a non-embedded ${tagName} asset`)
  return value
}

async function run() {
  let createdId = null
  let deleted = false

  try {
    const page = await request('/')
    assertStatus(page, 200, 'GET /')
    assert(
      page.response.headers.get('content-type')?.includes('text/html') === true,
      'GET / did not return text/html'
    )
    assert(page.body.includes('<main id="app"></main>'), 'GET / did not contain the Gea mount element')
    assert(
      page.body.includes('<title>Gea · Hono · MongoDB Todos</title>'),
      'GET / did not contain the embedded frontend title'
    )

    const scriptPath = extractAssetPath(page.body, 'script', 'src')
    const stylePath = extractAssetPath(page.body, 'link', 'href')

    const script = await request(scriptPath)
    assertStatus(script, 200, `GET ${scriptPath}`)
    assert(
      script.response.headers.get('content-type')?.includes('text/javascript') === true,
      `GET ${scriptPath} did not return JavaScript`
    )
    assert(script.body.includes('@geajs/core'), `GET ${scriptPath} did not contain the Gea app`)
    assert(
      script.body.includes('Missing #app mount element'),
      `GET ${scriptPath} did not contain the Gea bootstrap`
    )

    const style = await request(stylePath)
    assertStatus(style, 200, `GET ${stylePath}`)
    assert(
      style.response.headers.get('content-type')?.includes('text/css') === true,
      `GET ${stylePath} did not return CSS`
    )
    assert(style.body.includes('.todo-card'), `GET ${stylePath} did not contain the todo styles`)
    assert(style.body.includes('.todo-row'), `GET ${stylePath} did not contain the row styles`)

    const createdExchange = await request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: createdTitle })
    })
    assertStatus(createdExchange, 201, 'POST /api/todos')
    const created = parseJson(createdExchange, 'POST /api/todos')
    assert(isTodo(created), 'POST /api/todos did not return a complete todo body')
    createdId = created.id
    assertTodo(
      created,
      { id: createdId, title: createdTitle, completed: false },
      'POST /api/todos'
    )
    assert(created.createdAt === created.updatedAt, 'created todo timestamps did not initially match')

    const listedAfterCreateExchange = await request('/api/todos')
    assertStatus(listedAfterCreateExchange, 200, 'GET /api/todos after create')
    const listedAfterCreate = parseJson(listedAfterCreateExchange, 'GET /api/todos after create')
    assert(Array.isArray(listedAfterCreate), 'GET /api/todos after create did not return an array')
    assert(
      listedAfterCreate.every(isTodo),
      'GET /api/todos after create contained an invalid todo body'
    )
    const listedCreated = listedAfterCreate.find((todo) => todo?.id === createdId)
    assertTodo(
      listedCreated,
      { id: createdId, title: createdTitle, completed: false },
      'GET /api/todos after create'
    )
    assert(listedCreated.createdAt === created.createdAt, 'GET after create changed createdAt')
    assert(listedCreated.updatedAt === created.updatedAt, 'GET after create changed updatedAt')

    const patchedExchange = await request(`/api/todos/${createdId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: updatedTitle, completed: true })
    })
    assertStatus(patchedExchange, 200, 'PATCH /api/todos/:id')
    const patched = parseJson(patchedExchange, 'PATCH /api/todos/:id')
    assertTodo(
      patched,
      { id: createdId, title: updatedTitle, completed: true },
      'PATCH /api/todos/:id'
    )
    assert(patched.createdAt === created.createdAt, 'PATCH changed createdAt')
    assert(
      Date.parse(patched.updatedAt) >= Date.parse(created.updatedAt),
      'PATCH returned an older updatedAt timestamp'
    )

    const listedAfterPatchExchange = await request('/api/todos')
    assertStatus(listedAfterPatchExchange, 200, 'GET /api/todos after patch')
    const listedAfterPatch = parseJson(listedAfterPatchExchange, 'GET /api/todos after patch')
    assert(Array.isArray(listedAfterPatch), 'GET /api/todos after patch did not return an array')
    assert(
      listedAfterPatch.every(isTodo),
      'GET /api/todos after patch contained an invalid todo body'
    )
    const listedPatched = listedAfterPatch.find((todo) => todo?.id === createdId)
    assertTodo(
      listedPatched,
      { id: createdId, title: updatedTitle, completed: true },
      'GET /api/todos after patch'
    )
    assert(listedPatched.createdAt === patched.createdAt, 'GET after patch changed createdAt')
    assert(listedPatched.updatedAt === patched.updatedAt, 'GET after patch changed updatedAt')

    const removed = await request(`/api/todos/${createdId}`, { method: 'DELETE' })
    assertStatus(removed, 204, 'DELETE /api/todos/:id')
    assert(removed.body.length === 0, 'DELETE /api/todos/:id returned a response body')
    deleted = true

    const finalListExchange = await request('/api/todos')
    assertStatus(finalListExchange, 200, 'GET /api/todos after delete')
    const finalList = parseJson(finalListExchange, 'GET /api/todos after delete')
    assert(Array.isArray(finalList), 'GET /api/todos after delete did not return an array')
    assert(finalList.every(isTodo), 'GET /api/todos after delete contained an invalid todo body')
    assert(
      finalList.every((todo) => todo?.id !== createdId),
      'deleted todo was still present in the final list'
    )

    console.log(`FULLSTACK_HTTP_CORRECTNESS_OK:${createdId}`)
  } finally {
    if (createdId !== null && !deleted) {
      try {
        await request(`/api/todos/${createdId}`, { method: 'DELETE' })
      } catch {
        // Preserve the original assertion or transport error.
      }
    }
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`FULLSTACK_HTTP_CORRECTNESS_ERROR:${message}`)
  process.exitCode = 1
})
