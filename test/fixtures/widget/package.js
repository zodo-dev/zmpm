Package.describe({
  name: 'acme:widget',
  version: '0.2.0',
  summary: 'zmpm test fixture (root package)',
});
Package.onUse((api) => {
  api.versionsFrom('3.0');
  api.use('ecmascript');
  api.use('acme:core', 'server'); // same-org dep, no version → resolves @latest
  api.mainModule('server.js', 'server');
});
