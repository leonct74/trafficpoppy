// t.js — the ~1 KB script that runs on the visitor's page. Framework-free, dependency-free.
//
// It is authored here as a source string so the collector Lambda can serve it verbatim and
// so it can be unit-tested (tracker.test.ts asserts the privacy properties: no cookies, no
// storage, opt-out honored). It sends the LEAST it can: site id, path, referrer, viewport,
// and the allowlisted utm params — nothing that identifies a person.
//
// What it deliberately never does (DESIGN.md §3, §6): read/write cookies or localStorage,
// fingerprint (canvas/fonts), or send the full page URL or full referrer. The server does
// the final reduction (referrer→host, utm allowlist) too, but doing it here as well keeps
// sensitive strings off the wire in the first place.
//
// THE BODY MUST STAY A PLAIN STRING (⇒ text/plain, a CORS-safelisted type). sendBeacon is
// always credentials-include, so a Blob typed application/json forces a credentialed CORS
// preflight the collector's CORS config (rightly) refuses — sendBeacon returns true, then
// the browser silently drops the POST. A simple request needs no preflight, and a beacon
// never reads the response, so no CORS response check can stop the hit. The fetch fallback
// is the same story: mode:"no-cors" forbids a json content-type header outright. (Live
// ollydigital.com lesson — tracker.test.ts pins all of this.)

/**
 * Build the served script. `collectorOrigin` is where POST /e lives (the Function URL, or
 * later the custom domain) — baked in so the snippet the user pastes needs only data-site.
 */
export function trackerScript(collectorOrigin: string): string {
  // Trailing slash trimmed so `${origin}/e` is always well-formed.
  const origin = collectorOrigin.replace(/\/+$/, "");
  return `(function(){
  "use strict";
  var d=document,w=window,n=navigator;
  // Opt-out first: GPC or DNT ⇒ do nothing at all, not even a request.
  if(n.globalPrivacyControl===true||n.doNotTrack==="1"||w.doNotTrack==="1"||n.doNotTrack==="yes")return;
  var s=d.currentScript;
  var site=s&&s.getAttribute("data-site");
  if(!site)return;
  var last="";
  function utm(){
    try{
      var p=new URLSearchParams(w.location.search),o={},k=["utm_source","utm_medium","utm_campaign"];
      for(var i=0;i<k.length;i++){var v=p.get(k[i]);if(v)o[k[i]]=v;}
      return o;
    }catch(e){return {};}
  }
  function send(){
    var path=w.location.pathname;
    if(path===last)return; // de-dupe repeat fires for the same path (SPA re-renders)
    last=path;
    var u=utm();
    var body={s:site,p:path,r:d.referrer||"",w:w.innerWidth||0};
    if(u.utm_source)body.q=w.location.search;
    var json=JSON.stringify(body);
    // Plain-string body only — a typed body forces a CORS preflight that kills the hit.
    try{
      if(n.sendBeacon){n.sendBeacon("${origin}/e",json);return;}
    }catch(e){}
    try{fetch("${origin}/e",{method:"POST",body:json,keepalive:true,mode:"no-cors"});}catch(e){}
  }
  // Count the first load, then every SPA navigation (History API + back/forward).
  function hook(m){var o=history[m];history[m]=function(){var r=o.apply(this,arguments);send();return r;};}
  hook("pushState");hook("replaceState");
  w.addEventListener("popstate",send);
  if(d.readyState==="complete"||d.readyState==="interactive")send();
  else w.addEventListener("DOMContentLoaded",send);
})();`;
}

/** Response headers for serving t.js: correct type + a day of caching, immutable-ish. */
export function trackerHeaders(): Record<string, string> {
  return {
    "content-type": "application/javascript; charset=utf-8",
    "cache-control": "public, max-age=86400",
  };
}
