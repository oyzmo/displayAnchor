// Rasterises assets/icon.svg to PNGs with the globally-installed Chromium.
const {chromium} = require('playwright');
const fs = require('fs');
const path = require('path');

const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
const sizes = [512, 256, 128, 64, 48];

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    for (const size of sizes) {
        await page.setViewportSize({width: size, height: size});
        await page.setContent(
            `<body style="margin:0">${svg.replace(/width="512" height="512"/, `width="${size}" height="${size}"`)}</body>`);
        await page.screenshot({
            path: path.join(__dirname, `icon-${size}.png`),
            omitBackground: true,
        });
    }
    await browser.close();
    console.log('rendered: ' + sizes.map(s => `icon-${s}.png`).join(', '));
})();
