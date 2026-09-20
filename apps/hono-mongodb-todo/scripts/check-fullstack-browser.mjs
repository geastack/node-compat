import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const baseUrl = new URL(process.env.GEA_TODO_BASE_URL ?? 'http://127.0.0.1:3000')
const requestTimeoutMs = 10_000
const browserTimeoutMs = 15_000
const createdTitle = `full-stack browser correctness: ${randomUUID()}`

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function resolveBrowserPath() {
  const configuredPath = process.env.GEA_BROWSER_PATH
  if (configuredPath !== undefined && configuredPath.length > 0) {
    assert(existsSync(configuredPath), `GEA_BROWSER_PATH does not exist: ${configuredPath}`)
    return configuredPath
  }

  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ]
  const browserPath = candidates.find((candidate) => existsSync(candidate))
  assert(
    browserPath !== undefined,
    `Could not find a system Chrome or Chromium executable; set GEA_BROWSER_PATH`
  )
  return browserPath
}

function responseMatches(response, method, pathname) {
  const responseUrl = new URL(response.url())
  return (
    response.request().method() === method &&
    responseUrl.origin === baseUrl.origin &&
    responseUrl.pathname === pathname
  )
}

function waitForResponse(page, method, pathname) {
  return page.waitForResponse((response) => responseMatches(response, method, pathname), {
    timeout: browserTimeoutMs
  })
}

async function assertStatus(response, expected, label) {
  if (response.status() === expected) return
  const body = (await response.text()).slice(0, 240)
  throw new Error(
    `${label} returned HTTP ${response.status()}, expected ${expected}; body=${JSON.stringify(body)}`
  )
}

async function parseJson(response, label) {
  const contentType = response.headers()['content-type'] ?? ''
  assert(contentType.includes('application/json'), `${label} did not return application/json`)
  try {
    return await response.json()
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

async function assertNoAlert(page, label) {
  const alerts = await page.locator('[role="alert"]').allTextContents()
  assert(alerts.length === 0, `${label} rendered an error alert: ${alerts.join(' | ')}`)
}

async function readRemainingCount(page) {
  const text = (await page.locator('.list-heading span').textContent())?.trim() ?? ''
  const match = /^(\d+) remaining$/.exec(text)
  assert(match !== null, `remaining count had an unexpected value: ${JSON.stringify(text)}`)
  return Number(match[1])
}

async function waitForRemainingCount(page, expected) {
  await page.waitForFunction(
    (expectedCount) =>
      document.querySelector('.list-heading span')?.textContent?.trim() ===
      `${expectedCount} remaining`,
    expected,
    { timeout: browserTimeoutMs }
  )
  const actual = await readRemainingCount(page)
  assert(actual === expected, `remaining count was ${actual}, expected ${expected}`)
}

async function cleanupCreatedTodo(createdId) {
  const response = await fetch(new URL(`/api/todos/${createdId}`, baseUrl), {
    method: 'DELETE',
    signal: AbortSignal.timeout(requestTimeoutMs)
  })
  if (response.status !== 204 && response.status !== 404) {
    const body = (await response.text()).slice(0, 240)
    throw new Error(
      `cleanup DELETE /api/todos/:id returned HTTP ${response.status}; body=${JSON.stringify(body)}`
    )
  }
}

async function run() {
  let createdId = null
  let deleted = false
  let browser = null

  try {
    browser = await chromium.launch({
      executablePath: resolveBrowserPath(),
      headless: true
    })
    const context = await browser.newContext()
    const page = await context.newPage()
    page.setDefaultTimeout(browserTimeoutMs)
    page.setDefaultNavigationTimeout(browserTimeoutMs)

    const pageErrors = []
    page.on('pageerror', (error) => {
      pageErrors.push(error.stack ?? error.message)
    })

    const scriptResponsePromise = waitForResponse(page, 'GET', '/assets/app.js')
    const initialListResponsePromise = waitForResponse(page, 'GET', '/api/todos')
    const documentResponse = await page.goto(new URL('/', baseUrl).href, { waitUntil: 'load' })
    assert(documentResponse !== null, 'GET / did not return a document response')
    await assertStatus(documentResponse, 200, 'GET /')

    const [scriptResponse, initialListResponse] = await Promise.all([
      scriptResponsePromise,
      initialListResponsePromise
    ])
    await assertStatus(scriptResponse, 200, 'GET /assets/app.js')
    assert(
      (scriptResponse.headers()['content-type'] ?? '').includes('text/javascript'),
      'GET /assets/app.js did not return JavaScript'
    )
    const scriptBody = await scriptResponse.text()
    assert(scriptBody.includes('@geajs/core'), 'GET /assets/app.js did not contain the Gea app')
    assert(
      scriptBody.includes('Missing #app mount element'),
      'GET /assets/app.js did not contain the Gea bootstrap'
    )

    await assertStatus(initialListResponse, 200, 'initial GET /api/todos')
    const initialList = await parseJson(initialListResponse, 'initial GET /api/todos')
    assert(Array.isArray(initialList), 'initial GET /api/todos did not return an array')
    assert(initialList.every(isTodo), 'initial GET /api/todos contained an invalid todo body')

    assert(
      (await page.title()) === 'Gea · Hono · MongoDB Todos',
      'GET / returned the wrong document title'
    )
    await page.locator('#app > .page-shell').waitFor({ state: 'visible' })
    await page.locator('.todo-card').waitFor({ state: 'visible' })
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll('.empty-state')).some(
          (element) => element.textContent?.trim() === 'Loading tasks…'
        ),
      undefined,
      { timeout: browserTimeoutMs }
    )
    await assertNoAlert(page, 'initial load')
    const initialRemainingCount = await readRemainingCount(page)

    const input = page.locator('#new-todo')
    const addButton = page.locator('.todo-form button[type="submit"]')
    await input.fill(createdTitle)
    await page.waitForFunction(
      (title) => {
        const inputElement = document.querySelector('#new-todo')
        const buttonElement = document.querySelector('.todo-form button[type="submit"]')
        return (
          inputElement instanceof HTMLInputElement &&
          inputElement.value === title &&
          buttonElement instanceof HTMLButtonElement &&
          !buttonElement.disabled
        )
      },
      createdTitle,
      { timeout: browserTimeoutMs }
    )
    assert((await input.inputValue()) === createdTitle, 'Gea did not update the draft input value')
    assert(await addButton.isEnabled(), 'Add button did not become enabled')

    const createResponsePromise = waitForResponse(page, 'POST', '/api/todos')
    await addButton.click()
    const createResponse = await createResponsePromise
    await assertStatus(createResponse, 201, 'POST /api/todos')
    const created = await parseJson(createResponse, 'POST /api/todos')
    assert(isTodo(created), 'POST /api/todos did not return a complete todo body')
    createdId = created.id
    assert(created.title === createdTitle, 'POST /api/todos returned the wrong title')
    assert(created.completed === false, 'POST /api/todos returned a completed todo')

    const row = page
      .locator('li.todo-row')
      .filter({ has: page.getByText(createdTitle, { exact: true }) })
    await row.waitFor({ state: 'visible' })
    assert((await row.count()) === 1, 'created todo did not render exactly one row')
    assert(
      !(await row.getAttribute('class'))?.split(/\s+/).includes('is-complete'),
      'created todo row rendered as complete'
    )
    const toggleButton = row.locator('button.todo-check')
    assert(
      (await toggleButton.getAttribute('aria-label')) === `Mark ${createdTitle} complete`,
      'created todo toggle had the wrong accessible label'
    )
    await page.waitForFunction(
      () => document.querySelector('#new-todo')?.value === '',
      undefined,
      { timeout: browserTimeoutMs }
    )
    assert((await input.inputValue()) === '', 'Gea did not clear the draft after create')
    await waitForRemainingCount(page, initialRemainingCount + 1)
    await assertNoAlert(page, 'create')

    const patchResponsePromise = waitForResponse(page, 'PATCH', `/api/todos/${createdId}`)
    await toggleButton.click()
    const patchResponse = await patchResponsePromise
    await assertStatus(patchResponse, 200, 'PATCH /api/todos/:id')
    const patched = await parseJson(patchResponse, 'PATCH /api/todos/:id')
    assert(isTodo(patched), 'PATCH /api/todos/:id did not return a complete todo body')
    assert(patched.id === createdId, 'PATCH /api/todos/:id returned the wrong id')
    assert(patched.title === createdTitle, 'PATCH /api/todos/:id returned the wrong title')
    assert(patched.completed === true, 'PATCH /api/todos/:id did not complete the todo')

    await page
      .locator('li.todo-row.is-complete')
      .filter({ has: page.getByText(createdTitle, { exact: true }) })
      .waitFor({ state: 'visible' })
    assert(
      (await row.getAttribute('class'))?.split(/\s+/).includes('is-complete') === true,
      'toggled todo row did not gain the is-complete class'
    )
    assert(
      (await toggleButton.getAttribute('aria-label')) === `Mark ${createdTitle} incomplete`,
      'toggled todo toggle had the wrong accessible label'
    )
    assert(
      (await toggleButton.locator('span').textContent()) === '✓',
      'toggled todo did not render its checkmark'
    )
    await waitForRemainingCount(page, initialRemainingCount)
    await assertNoAlert(page, 'toggle')

    const deleteButton = row.getByRole('button', {
      name: `Delete ${createdTitle}`,
      exact: true
    })
    const deleteResponsePromise = waitForResponse(page, 'DELETE', `/api/todos/${createdId}`)
    await deleteButton.click()
    const deleteResponse = await deleteResponsePromise
    await assertStatus(deleteResponse, 204, 'DELETE /api/todos/:id')
    deleted = true

    await row.waitFor({ state: 'detached' })
    await waitForRemainingCount(page, initialRemainingCount)
    await assertNoAlert(page, 'delete')
    assert(
      pageErrors.length === 0,
      `browser page errors: ${pageErrors.join(' | ')}`
    )

    console.log(`FULLSTACK_BROWSER_CORRECTNESS_OK:${createdId}`)
  } finally {
    if (createdId !== null && !deleted) {
      try {
        await cleanupCreatedTodo(createdId)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        console.error(`FULLSTACK_BROWSER_CLEANUP_ERROR:${detail}`)
      }
    }
    if (browser !== null) await browser.close()
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`FULLSTACK_BROWSER_CORRECTNESS_ERROR:${message}`)
  process.exitCode = 1
})
