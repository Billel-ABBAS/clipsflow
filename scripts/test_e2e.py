from playwright.sync_api import sync_playwright

out = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    # Landing
    page.goto('https://clipsflow-liart.vercel.app/en', timeout=60000)
    page.wait_for_load_state('networkidle')
    out.append('=== LANDING /en ===')
    out.append('URL: ' + page.url)
    out.append('Title: ' + page.title())
    h1s = page.locator('h1').all()
    out.append('H1 count: ' + str(len(h1s)))
    for h in h1s:
        out.append('  H1: ' + h.inner_text()[:100])

    # Login page
    page.goto('https://clipsflow-liart.vercel.app/en/login', timeout=60000)
    page.wait_for_load_state('networkidle')
    out.append('\n=== LOGIN /en/login ===')
    out.append('URL: ' + page.url)
    out.append('Title: ' + page.title())
    h1 = page.locator('h1').first
    if h1.count():
        out.append('H1: ' + h1.inner_text()[:100])
    out.append('Email input: ' + str(page.locator('input[type="email"]').count()))
    out.append('Password input: ' + str(page.locator('input[type="password"]').count()))
    out.append('Submit button: ' + str(page.locator('button[type="submit"]').count()))

    # Screenshot
    page.screenshot(path='login.png', full_page=True)
    out.append('Screenshot: login.png')

    browser.close()

open('test_result.txt', 'w', encoding='utf-8').write('\n'.join(out))
print('\n'.join(out))
