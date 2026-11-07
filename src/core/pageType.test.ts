// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { detectPageType, pageTypeFromDom, pageTypeFromUrl } from './pageType';
import { fixture } from './testing';

describe('pageTypeFromUrl', () => {
  it.each([
    ['https://shop.example/checkout/address', 'checkout'],
    ['https://shop.example/payment?step=2', 'checkout'],
    ['https://shop.example/viewcart', 'cart'],
    ['https://shop.example/cart', 'cart'],
    ['file:///Users/me/test-shop/cart.html', 'cart'],
    ['https://www.amazon.in/Aarav-Earbuds/dp/B0ABC12345', 'product'],
    ['https://shop.example/p/itm123', 'product'],
    ['file:///Users/me/test-shop/product.html', 'product'],
    ['https://www.amazon.in/s?k=earbuds', 'listing'],
    ['https://shop.example/search?q=earbuds', 'listing'],
  ])('%s → %s', (url, type) => {
    expect(pageTypeFromUrl(url)).toBe(type);
  });

  it('returns null when the URL says nothing', () => {
    expect(pageTypeFromUrl('https://shop.example/')).toBeNull();
    expect(pageTypeFromUrl('https://shop.example/handbags-sale')).toBeNull();
  });
});

describe('pageTypeFromDom', () => {
  it('sees an address field as checkout', () => {
    fixture('<form><input autocomplete="street-address"></form>');
    expect(pageTypeFromDom(document)).toBe('checkout');
  });

  it('sees a payment heading plus place order as checkout', () => {
    fixture('<h2>Payment</h2><button>Place order</button>');
    expect(pageTypeFromDom(document)).toBe('checkout');
  });

  it('sees proceed to checkout or an order summary as cart', () => {
    fixture('<a href="/c">Proceed to checkout</a>');
    expect(pageTypeFromDom(document)).toBe('cart');
    fixture('<h2>Order summary</h2>');
    expect(pageTypeFromDom(document)).toBe('cart');
  });

  it('sees several add-to-cart buttons as listing and one as product', () => {
    fixture('<button>Add to cart</button>'.repeat(3));
    expect(pageTypeFromDom(document)).toBe('listing');
    fixture('<button>Add to cart</button>');
    expect(pageTypeFromDom(document)).toBe('product');
    fixture('<a href="/buy">Buy now</a>');
    expect(pageTypeFromDom(document)).toBe('product');
  });

  it('falls back to other', () => {
    fixture('<p>Hello</p>');
    expect(pageTypeFromDom(document)).toBe('other');
  });

  it('prefers the URL over DOM cues', () => {
    fixture('<a href="/c">Proceed to checkout</a>');
    expect(detectPageType(document, 'https://shop.example/product/1')).toBe('product');
    expect(detectPageType(document, 'https://shop.example/')).toBe('cart');
  });
});
