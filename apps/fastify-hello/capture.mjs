const Orig = Function;
const gen = [];
const Hooked = new Proxy(Orig, {
  construct(t, args) { gen.push(args); return Reflect.construct(t, args); },
  apply(t, thisArg, args) { if (args.length && typeof args[args.length-1]==='string' && args[args.length-1].length>40) gen.push(args); return Reflect.apply(t, thisArg, args); }
});
globalThis.Function = Hooked;
const Fastify = (await import('fastify')).default;
const app = Fastify({ logger: false });
app.get('/', (req, reply) => reply.send('Hello Fastify!'));
app.get('/json', (req, reply) => reply.send({ hello: 'world' }));
await app.ready();
globalThis.Function = Orig;
const uniq = new Map();
for (const args of gen) { const b = args[args.length-1]; if (!uniq.has(b)) uniq.set(b, args.slice(0,-1)); }
console.log('total new Function:', gen.length, ' unique bodies:', uniq.size);
let i=0;
for (const [body, params] of uniq) {
  console.log(`\n==== UNIQUE[${i++}] params=[${params.join(', ')}] len=${body.length} ====`);
  console.log(body);
}
