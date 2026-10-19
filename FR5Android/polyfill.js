// Web/DOMのポリフィル: file-saver 等のWeb向けライブラリがロード時に HTMLAnchorElement 等を参照してクラッシュするのを防ぐ
if (typeof globalThis.HTMLAnchorElement === 'undefined') {
  const dummy = function() {};
  dummy.prototype = {};
  global.HTMLAnchorElement = dummy;
  globalThis.HTMLAnchorElement = dummy;
  if (typeof window !== 'undefined') {
    window.HTMLAnchorElement = dummy;
  }
}
