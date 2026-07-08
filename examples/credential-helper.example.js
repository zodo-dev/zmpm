#!/usr/bin/env node
// Example zmpm credential helper.
//
// Protocol: zmpm writes a JSON request to stdin and reads a JSON response from
// stdout.
//   request:  { "url": "<requested url>", "host": "<host>", "method": "GET" }
//   response: { "headers": { "<name>": "<value>", ... }, "url": "<optional rewrite>" }
//
// Returning `url` lets the helper hand back a DIFFERENT url to fetch — the key
// use case being object storage: take a logical/private url and return a
// short-lived PRE-SIGNED url (e.g. S3/GCS/OCI) that carries its own auth. The
// helper can shell out to `aws s3 presign`, call an internal signing service,
// mint a short-lived token, read a secret manager, etc.
//
// Configure it via `.zmpmrc` ("credentialHelper") or `--credential-helper`.

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const req = JSON.parse(input || '{}');
  const res = { headers: {} };

  // Example 1: attach a bearer for a specific host.
  if (req.host === 'pkgs.example.com') {
    res.headers.Authorization = `Bearer ${process.env.MY_REGISTRY_TOKEN || ''}`;
  }

  // Example 2: pre-sign a storage URL (pseudo — replace with a real signer).
  // if (req.host === 'my-bucket.s3.amazonaws.com') {
  //   res.url = presign(req.url); // e.g. execFileSync('aws', ['s3','presign', req.url])
  // }

  process.stdout.write(JSON.stringify(res));
});
