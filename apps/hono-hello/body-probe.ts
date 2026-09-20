async function main(): Promise<void> {
  const jsonRequest = new Request('http://localhost/json', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"name":"gea","count":3,"items":[true,null]}'
  })
  console.log(JSON.stringify(await jsonRequest.json()))

  const urlEncodedRequest = new Request('http://localhost/form', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=Gea+Stack&tag=a&tag=b'
  })
  const urlEncoded = await urlEncodedRequest.formData()
  const tags = urlEncoded.getAll('tag')
  console.log(String(urlEncoded.get('name')) + ':' + String(tags[0]) + ',' + String(tags[1]))

  const boundary = 'gea-probe-boundary'
  const prefix =
    '--' + boundary + '\r\nContent-Disposition: form-data; name="title"\r\n\r\nhéllo'
  const fileHead =
    '\r\n--' +
    boundary +
    '\r\nContent-Disposition: form-data; name="asset"; filename="x.bin"\r\n' +
    'Content-Type: application/octet-stream\r\n\r\n'
  const suffix = '\r\n--' + boundary + '--\r\n'
  const falseBoundary = Buffer.from('\r\n--' + boundary + '-inside-file', 'utf8')
  const binary = Buffer.alloc(3 + falseBoundary.length)
  binary[0] = 0
  binary[1] = 1
  binary[2] = 255
  for (let i = 0; i < falseBoundary.length; i++) binary[i + 3] = falseBoundary[i]
  const multipartBytes = Buffer.concat([
    Buffer.from(prefix),
    Buffer.from(fileHead),
    binary,
    Buffer.from(suffix)
  ])
  const multipartRequest = new Request('http://localhost/upload', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary="' + boundary + '"' },
    body: multipartBytes
  })
  const multipart = await multipartRequest.formData()
  const asset = multipart.get('asset')
  if (!(asset instanceof File)) throw new Error('multipart file was not decoded as File')
  const assetBytes = (await asset.bytes()).slice(0, 3)
  console.log(
    String(multipart.get('title')) +
      ':' +
      asset.name +
      ':' +
      asset.type +
      ':' +
      asset.size +
      ':' +
      String(assetBytes[0]) +
      ',' +
      String(assetBytes[1]) +
      ',' +
      String(assetBytes[2])
  )

  const outgoing = new FormData()
  outgoing.append('field', 'värde')
  outgoing.append(
    'file',
    new Blob([new Uint8Array([0, 127, 255]).buffer], { type: 'application/x-test' }),
    'a.bin'
  )
  const roundTripRequest = new Request('http://localhost/round-trip', {
    method: 'POST',
    body: outgoing
  })
  const roundTrip = await roundTripRequest.formData()
  const roundTripFile = roundTrip.get('file')
  if (!(roundTripFile instanceof File)) throw new Error('FormData Blob did not become a File')
  const roundTripBytes = await roundTripFile.bytes()
  console.log(
    String(roundTrip.get('field')) +
      ':' +
      roundTripFile.name +
      ':' +
      roundTripFile.size +
      ':' +
      String(roundTripBytes[0]) +
      ',' +
      String(roundTripBytes[1]) +
      ',' +
      String(roundTripBytes[2])
  )
}

await main()
