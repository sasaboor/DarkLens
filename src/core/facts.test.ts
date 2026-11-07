// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { extractCandidates } from './extractor';
import { collectFacts, inRepeatedList, linkKey, readCartCount, siteKey, urlKey } from './facts';
import { fakeLayout, fixture } from './testing';

const URL = 'https://shop.example/product/earbuds?ref=home#reviews';

function facts(body: string, css = '', url = URL) {
  const doc = fixture(body, css);
  const layout = fakeLayout();
  const ex = extractCandidates(doc, { layout, url });
  return { ex, ...collectFacts(ex, layout, doc, url) };
}

function byText(ex: ReturnType<typeof facts>['ex'], text: string) {
  return ex.candidates.find((c) => c.text === text)!;
}

describe('URL keys', () => {
  it('keys pages by origin and path and sites by origin', () => {
    expect(urlKey(URL)).toBe('https://shop.example/product/earbuds');
    expect(siteKey(URL)).toBe('https://shop.example');
  });

  it('resolves real links and ignores "#" and javascript: links', () => {
    const a = document.createElement('a');
    a.setAttribute('href', '../cart.html?x=1');
    expect(linkKey(a, URL)).toBe('https://shop.example/cart.html');
    a.setAttribute('href', '#');
    expect(linkKey(a, URL)).toBeNull();
    a.setAttribute('href', 'javascript:void(0)');
    expect(linkKey(a, URL)).toBeNull();
  });
});

describe('per-candidate facts', () => {
  it('records font size, grey text and struck prices', () => {
    const { ex, byId } = facts(
      `<div class="price-row"><span class="now">₹999</span><span class="mrp">₹1,999</span></div>
       <button class="tiny">Not now</button>`,
      '.now { font-size: 17px } .mrp { text-decoration: line-through; font-size: 12px } .tiny { font-size: 10px; color: #a3a3a3 }',
    );
    expect(byId[byText(ex, '₹999').id]).toMatchObject({ fontSize: 17, struck: false });
    expect(byId[byText(ex, '₹1,999').id]).toMatchObject({ fontSize: 12, struck: true });
    expect(byId[byText(ex, 'Not now').id]).toMatchObject({ fontSize: 10, grey: true });
  });

  it('finds the amount on a fee row and marks radios', () => {
    const { ex, byId } = facts(
      `<div class="row"><span>Platform fee</span><span>₹9</span></div>
       <label><input type="radio" name="d" checked> Standard delivery</label>`,
    );
    expect(byId[byText(ex, 'Platform fee').id]!.lineAmount).toBe(9);
    expect(byId[byText(ex, 'Standard delivery').id]!.radio).toBe(true);
  });

  it('knows when an element sits in a product grid or a review list', () => {
    fixture(`
      <div class="grid">
        <article class="card"><span id="ad">Sponsored</span></article>
        <article class="card">₹10</article><article class="card">₹20</article>
      </div>
      <section class="reviews">
        <div class="review">a</div><div class="review">b</div><div class="review review-ad"><span id="ad2">Sponsored</span></div>
      </section>
      <div class="header"><span id="lone">Sponsored</span></div>`);
    expect(inRepeatedList(document.getElementById('ad')!)).toBe(true);
    expect(inRepeatedList(document.getElementById('ad2')!)).toBe(true);
    expect(inRepeatedList(document.getElementById('lone')!)).toBe(false);
  });
});

describe('priced items', () => {
  it('reads listing cards: title, link and the first non-struck price', () => {
    const { page } = facts(
      `<div class="grid">
        <article class="card"><a class="title" href="/p/earbuds">Aarav Wireless Earbuds Pro</a>
          <span class="mrp">₹1,999</span><span>₹999</span></article>
        <article class="card"><a class="title" href="#">Kaveri Steel Water Bottle 1L</a><span>₹199</span></article>
      </div>`,
      '.mrp { text-decoration: line-through }',
      'https://shop.example/search?q=deals',
    );
    expect(page.items).toEqual([
      { title: 'Aarav Wireless Earbuds Pro', href: 'https://shop.example/p/earbuds', price: 999, candidateId: expect.any(String), offers: [] },
      { title: 'Kaveri Steel Water Bottle 1L', href: null, price: 199, candidateId: expect.any(String), offers: [] },
    ]);
  });

  it('takes the h1 item as the product on a product page, keyed by the page URL', () => {
    const { page } = facts(
      `<div class="panel"><h1>Aarav Wireless Earbuds Pro</h1><span class="big">₹1,299</span>
        <div class="plus"><b>Free 1-day delivery</b><div>Rs 199/month after trial</div></div>
        <button>Add to cart</button></div>`,
      '.big { font-size: 28px }',
    );
    expect(page.pageType).toBe('product');
    expect(page.product).toMatchObject({ title: 'Aarav Wireless Earbuds Pro', price: 1299, href: 'https://shop.example/product/earbuds' });
  });

  it('keys the product by link[rel=canonical] when present, and reads live offers only', () => {
    const { page } = facts(
      `<div class="panel"><h1>Aarav Wireless Earbuds Pro</h1><span class="big">₹1,299</span>
        <span class="mrp">₹1,999</span><span>50% off offer ended</span><span class="badge">Buy 1 Get 1</span></div>`,
      '.big { font-size: 28px } .mrp { text-decoration: line-through }',
    );
    expect(page.product!.offers).toEqual(['buy 1 get 1']);
    expect(page.canonical).toBeNull();
    // fixture() replaces <head>, so the link goes in the markup; querySelector finds it either way.
    const withLink = `<link rel="canonical" href="https://shop.example/dp/B0XYZ?tag=x">${document.body.innerHTML}`;
    const again = facts(withLink, '.big { font-size: 28px }', 'https://shop.example/product/earbuds?ref=home');
    expect(again.page.canonical).toBe('https://shop.example/dp/B0XYZ');
    expect(again.page.product!.href).toBe('https://shop.example/dp/B0XYZ');
  });

  it('reads cart rows whose title is plain bold text', () => {
    const { page } = facts(
      `<h1>Shopping cart</h1>
       <article class="cart-item"><b>Kaveri Stainless Steel Water Bottle 1L</b><div>₹349</div><div>Deal price ₹199 no longer applies</div></article>`,
      '',
      'https://shop.example/cart',
    );
    expect(page.items.map((i) => [i.title, i.price])).toEqual([['Kaveri Stainless Steel Water Bottle 1L', 349]]);
  });
});

describe('cart badge', () => {
  it('reads the number on a cart link and ties it to its candidate', () => {
    const { ex, page } = facts('<a href="cart.html" class="cart-link">Cart<span class="cart-badge">3</span></a><button>Add to cart</button>');
    expect(page.cartCount).toEqual({ count: 3, candidateId: byText(ex, 'Cart 3').id });
  });

  it('falls back to an aria-label and returns null without a badge', () => {
    fixture('<button aria-label="Basket, 4 items">🛒</button>');
    expect(readCartCount(document)?.count).toBe(4);
    fixture('<button>Add to cart</button>');
    expect(readCartCount(document)).toBeNull();
  });
});
