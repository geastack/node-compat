import { AsyncResource } from 'node:async_hooks'

class Holder {
  id: number = 7
}

const resource = new AsyncResource('probe')
const holder = new Holder()
const bound = resource.runInAsyncScope(function (this: Holder, extra: number): string {
  return `${this.id}+${extra}`
}, holder, 1)
console.log(`receiver ${bound}`)
const none = resource.runInAsyncScope((left: number, right: number): number => left + right, undefined, 2, 3)
console.log(`arguments ${none}`)
