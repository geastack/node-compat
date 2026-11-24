export async function run({ shim, original, assert }) {
  let count = 0
  const both = (label, call) => {
    const results = [shim, original].map((m) => { try { return { value: call(m) } } catch (error) { return { error: `${error.constructor.name}: ${error.message}` } } })
    assert.deepEqual(results[0], results[1], label)
    count++
  }
  const texts = [
    '{"a":1}', '[1,2,{"b":null}]', '"str"', '1', 'null', 'true', '', 'not json', '{"a":', '\uFEFF{"a":1}',
    '{"__proto__":{"x":1}}', '{"a":{"__proto__":{"x":1}}}', '[{"__proto__":1}]', '{"\\u005f_proto__":1}', '{"__proto__" :1}', '{"__proto__x":1}',
    '{"constructor":{"prototype":{"x":1}}}', '{"constructor":{"x":1}}', '{"constructor":1}', '{"a":[{"constructor":{"prototype":1}}]}',
    '{"\\u0063onstructor":{"prototype":1}}', '{"constructor":{"prototype":1},"__proto__":1}', '{"x":"__proto__"}', '{"x":"\\"__proto__\\":"}',
    '{"deep":{"deeper":{"deepest":{"__proto__":{}}}}}', '{"arr":[[[{"constructor":{"prototype":[]}}]]]}'
  ]
  const actions = [undefined, 'error', 'remove', 'ignore']
  for (const text of texts) {
    for (const protoAction of actions) for (const constructorAction of actions) {
      const options = {}
      if (protoAction) options.protoAction = protoAction
      if (constructorAction) options.constructorAction = constructorAction
      both(`parse(${text}, ${JSON.stringify(options)})`, (m) => m.parse(text, options))
      both(`parse(${text}, null, ${JSON.stringify(options)})`, (m) => m.parse(text, null, options))
      both(`default.parse(${text}, ${JSON.stringify(options)})`, (m) => (m.default ?? m).parse(text, options))
      both(`parse(Buffer ${text})`, (m) => m.parse(Buffer.from(text), options))
      both(`parse safe ${text}`, (m) => m.parse(text, { ...options, safe: true }))
    }
    both(`parse reviver ${text}`, (m) => m.parse(text, (k, v) => (typeof v === 'number' ? v * 2 : v)))
    both(`parse reviver+options ${text}`, (m) => m.parse(text, (k, v) => v, { protoAction: 'remove', constructorAction: 'remove' }))
    both(`safeParse ${text}`, (m) => m.safeParse(text))
    both(`safeParse reviver ${text}`, (m) => m.safeParse(text, (k, v) => v))
    let parsed
    try { parsed = JSON.parse(text) } catch { continue }
    if (parsed === null || typeof parsed !== 'object') continue
    for (const protoAction of actions) for (const constructorAction of actions) {
      const options = { protoAction, constructorAction }
      both(`scan ${text} ${JSON.stringify(options)}`, (m) => m.scan(JSON.parse(text), options))
      both(`scan safe ${text} ${JSON.stringify(options)}`, (m) => m.scan(JSON.parse(text), { ...options, safe: true }))
    }
    both(`scan default ${text}`, (m) => m.scan(JSON.parse(text)))
  }
  return count
}
