import { URLSearchParams } from 'node:url'

const parameters = new URLSearchParams('a=1&b=2')
const keys = parameters.keys()
for (const key of keys) {
  console.log(key)
  if (key === 'a') parameters.append('c', '3')
}
for (const [key, value] of parameters) console.log(key, value)

class DerivedParameters extends URLSearchParams {
  override keys(): IterableIterator<string> {
    return super.keys()
  }
}
for (const key of new DerivedParameters('x=4').keys()) console.log(key)
