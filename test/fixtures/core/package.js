Package.describe({
  name: 'acme:core',
  version: '0.1.0',
  summary: 'zmpm test fixture (dependency)',
});
Package.onUse((api) => {
  api.versionsFrom('3.0');
  api.use('ecmascript');
  api.mainModule('server.js', 'server');
});
