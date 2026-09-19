const { defineConfig, devices } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  fullyParallel: true,
  workers: 2,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:8080',
    launchOptions: process.env.CHROMIUM_PATH ? {
      executablePath: process.env.CHROMIUM_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--disable-gpu']
    } : {},
    trace: 'retain-on-failure'
  },
  projects: [
    { name:'desktop', use: { ...devices['Desktop Chrome'] } },
    { name:'mobile', use: { ...devices['Pixel 7'] } }
  ],
  webServer: { command:'python3 -m http.server 8080 --bind 0.0.0.0', url:'http://127.0.0.1:8080', reuseExistingServer: !process.env.CI }
});
