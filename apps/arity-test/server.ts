// Probe: arrows with FEWER params than the typed function slot must adapt
// (TS allows it; the emitted std::function must too).
type Cb = (chunk: string) => void

class Holder {
  fns: Cb[] = []
  add(fn: Cb): void {
    this.fns.push(fn)
  }
  fire(payload: string): void {
    for (const fn of this.fns) fn(payload)
  }
}

const h = new Holder()
let out = ''
h.add((chunk: string) => {
  out += 'full:' + chunk + ';'
})
h.add(() => {
  out += 'noarg;'
})
h.fire('X')
console.log('result=[' + out + ']')
