class Holder {
  body: any = undefined
}
const holder = new Holder()
const fromField: string | undefined = JSON.stringify(holder.body)
console.log('field undefined === undefined', fromField === undefined)
console.log('field typeof', typeof holder.body)
function stringifyUnknown(body: unknown): string | undefined {
  return JSON.stringify(body)
}
console.log('param unknown === undefined', stringifyUnknown(holder.body) === undefined)
console.log('param unknown object', stringifyUnknown({ a: 1 }))
const dynamic: unknown = undefined
const fromUnknown: string | undefined = JSON.stringify(dynamic)
console.log('unknown undefined === undefined', fromUnknown === undefined)
holder.body = { a: [1, null, 'x'] }
const fromObject: string | undefined = JSON.stringify(holder.body)
console.log('object', fromObject)
console.log('null', JSON.stringify(null))
