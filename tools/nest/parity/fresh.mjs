export async function run({ shim, original, assert }) {
  let count = 0
  const both = (label, req, res) => {
    assert.equal(shim.default(req, res), original(req, res), label)
    count++
  }

  const etag = '"foo"'
  const weak = 'W/"foo"'
  const lm = 'Sat, 01 Jan 2000 00:00:00 GMT'
  const later = 'Sat, 01 Jan 2000 01:00:00 GMT'
  const earlier = 'Fri, 31 Dec 1999 23:00:00 GMT'

  const requests = {
    none: {},
    inmMatch: { 'if-none-match': etag },
    inmWeak: { 'if-none-match': weak },
    inmOther: { 'if-none-match': '"bar"' },
    inmStar: { 'if-none-match': '*' },
    inmList: { 'if-none-match': '"bar", "foo"' },
    inmListSpaces: { 'if-none-match': '  "bar" ,  "foo"  ' },
    inmListNoSpace: { 'if-none-match': '"bar","foo"' },
    inmEmpty: { 'if-none-match': '' },
    inmTrailingComma: { 'if-none-match': '"foo",' },
    inmLeadingComma: { 'if-none-match': ',"foo"' },
    imsEqual: { 'if-modified-since': lm },
    imsLater: { 'if-modified-since': later },
    imsEarlier: { 'if-modified-since': earlier },
    imsInvalid: { 'if-modified-since': 'not a date' },
    imsEmpty: { 'if-modified-since': '' },
    bothMatch: { 'if-none-match': etag, 'if-modified-since': earlier },
    bothStale: { 'if-none-match': '"bar"', 'if-modified-since': later },
    noCache: { 'if-none-match': etag, 'cache-control': 'no-cache' },
    noCacheList: { 'if-none-match': etag, 'cache-control': 'max-age=0, no-cache' },
    noCacheSpaces: { 'if-none-match': etag, 'cache-control': ' no-cache ' },
    noCacheOther: { 'if-none-match': etag, 'cache-control': 'no-cache-x' },
    noCacheQuoted: { 'if-none-match': etag, 'cache-control': 'no-store' },
    noCacheIms: { 'if-modified-since': later, 'cache-control': 'no-cache' }
  }
  const responses = {
    none: {},
    etag: { etag },
    weak: { etag: weak },
    lm: { 'last-modified': lm },
    both: { etag, 'last-modified': lm },
    emptyEtag: { etag: '', 'last-modified': lm },
    undefinedEtag: { etag: undefined, 'last-modified': lm },
    invalidLm: { etag, 'last-modified': 'garbage' }
  }
  for (const [reqName, req] of Object.entries(requests)) {
    for (const [resName, res] of Object.entries(responses)) both(`fresh(${reqName}, ${resName})`, req, res)
  }

  return count
}
