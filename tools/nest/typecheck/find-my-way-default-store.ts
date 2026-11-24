import FindMyWay from '../../../runtime/node/nest/shims/find-my-way/index.ts'

const router = FindMyWay()
router.get('/docs', () => {}, { owner: 'docs' })
router.on('GET', '/guide', () => {}, { owner: 'guide' })
router.on('GET', '/plain', () => {})

const typed = FindMyWay<{ owner: string }>()
typed.get('/docs', () => {}, { owner: 'docs' })
// @ts-expect-error an explicit store type stays checked
typed.get('/bad', () => {}, { owner: 1 })
