// 运行在网页自身环境里：视频播放器下载字幕文件时顺带抄一份，交给插件统计高频词。
// 只读取响应内容，不修改网页的任何请求。
(() => {
  if (window.__llCapture) return;
  window.__llCapture = true;
  const MATCH = /\/api\/timedtext|\/subtitle|aisubtitle|\.vtt(\?|$)|\.srt(\?|$)/;
  const post = (url, body) => window.postMessage({ source: 'll-capture', url: String(url), body }, '*');

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url;
      if (url && MATCH.test(url)) res.clone().text().then((body) => post(url, body), () => {});
    } catch (e) {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__llUrl = String(url);
    return origOpen.call(this, method, url, ...rest);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__llUrl && MATCH.test(this.__llUrl)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') post(this.__llUrl, this.responseText);
          else if (this.responseType === 'json') post(this.__llUrl, JSON.stringify(this.response));
        } catch (e) {}
      });
    }
    return origSend.apply(this, args);
  };
})();
