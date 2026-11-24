// bson's ObjectId constructor runs its snapshot probe
// (`process.getBuiltinModule('v8')`, then `startupSnapshot?.isBuildingSnapshot?.()`)
// on the first id. bson 7.3.4 stores that result in a `boolean`, which only
// type-checks with the module typed `any`, as bson's own project types it.
// Prints nothing that differs between runs: lengths, hex round trips and
// equality.

import { ObjectId } from 'bson'

const created = new ObjectId()
const hex = created.toHexString()
console.log('length', hex.length, /^[0-9a-f]{24}$/.test(hex))
const parsed = new ObjectId(hex)
console.log('round trip', parsed.toHexString() === hex, parsed.equals(created))
const fixed = ObjectId.createFromHexString('0123456789abcdef01234567')
console.log('fixed', fixed.toHexString(), ObjectId.isValid('0123456789abcdef01234567'), ObjectId.isValid('not an id'))
console.log('distinct', new ObjectId().toHexString() !== hex)
