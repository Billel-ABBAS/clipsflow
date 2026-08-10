from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp('http://localhost:9222')
    page = browser.contexts[0].pages[0] if browser.contexts else browser.new_page()

    # Go to Stripe dashboard
    page.goto('https://dashboard.stripe.com/test/products', timeout=60000)
    page.wait_for_load_state('networkidle')

    # Check if we're logged in or on a login page
    url = page.url
    title = page.title()
    content = page.content()

    if 'login' in content.lower() or 'sign in' in content.lower() or 'auth' in url:
        print('NEED LOGIN: Stripe dashboard requires authentication')
        print('Current URL:', url)
        print('Title:', title)
        # Wait for user to log in manually then continue
    else:
        print('LOGGED IN')
        print('URL:', url)
        print('Title:', title)

        # Try to extract API keys from the page
        # Look for API keys section
        try:
            page.goto('https://dashboard.stripe.com/test/apikeys', timeout=60000)
            page.wait_for_load_state('networkidle')
            print('\n=== API KEYS PAGE ===')
            print('Title:', page.title())
            # Try to read the page source for the keys
            body = page.evaluate('() => document.body.innerText')
            print(body[:3000])
        except Exception as e:
            print('Error on API keys page:', e)

        # Look at webhook endpoints
        try:
            page.goto('https://dashboard.stripe.com/test/webhooks', timeout=60000)
            page.wait_for_load_state('networkidle')
            print('\n=== WEBHOOKS PAGE ===')
            print('Title:', page.title())
            body2 = page.evaluate('() => document.body.innerText')
            print(body2[:3000])
        except Exception as e:
            print('Error on webhooks page:', e)

    browser.close()
