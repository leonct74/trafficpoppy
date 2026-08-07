// The browser dashboard's HTML, served by the viewer Lambda (DESIGN.md §7b).
//
// This IS the product's face (founder decision 2026-08-04, amending §7c): TrafficPoppy is
// a serious, compliant alternative to Google Analytics, so the online dashboard carries
// professional charts — trend, traffic flow, countries with flags — not a plain list.
// Monetisation stays with True Reach (per-domain), not with chart quality.
//
// Dependency-free ON PURPOSE: this page is embedded in a Lambda that shares a zip with the
// hot collector path, and a viewer's first paint should not wait on a framework download.
// Every chart below is hand-rolled SVG. It talks to Cognito directly for login and to
// /api/* for data.
//
// It renders NO data before authentication — the markup below contains only a login form;
// every number arrives from an authenticated fetch afterwards.

import { passwordRules } from "../../shared/src/password-policy";

export interface PageConfig {
  region: string;
  userPoolClientId: string;
}

/** Escape a value for safe inclusion in a JS string literal inside <script>. */
const js = (s: string) => JSON.stringify(s ?? "");

export function dashboardHtml(cfg: PageConfig): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Analytics</title>
<!-- Favicon: TrafficPoppy's own icon, inline as a data URI (64px, ~1.4 KB). Inline so
     the page stays entirely self-contained — nothing ever leaves for a third party —
     and so a missing /favicon.ico never 404s through the edge on every visit. -->
<link rel="icon" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAFIklEQVR42u1aPWxbVRT+zrnPz3ZiJ1YaNWojlY0hwILY2w6tRFAlpMpZKBMtXYo6gGgHpPfeAqrapQoMpfxIUAZsdapIClOzIAYQA6VIJSxIIeTPsWMn/nv3HgbbaZtfB5pSv7xPuoPle+9777vn3PMLhAgRIkSIECH2KqgTX1pE1r03EQCQBPq0HEfYEeHN/s9kRAVWAkSEiBon/OUP0sP1gkIBKKCA3kOHcHABxaNHyd/pvtwpJ09E8unYX0NfTCyO6XLufqVSmSzb5T+i0ehkdW7u9z958bdPvpu+0JofGAlo6ftn49P9FFU/J5J9g8vFPIgevLpAwMRIpvqQm5999/SxgcuZjKiREdIdLwHuHSgiErH5ZCLZN7iUn69q7Yvv11eH9n2p12t+qVjQEPPW1bH70ZERMoBQxxNwZPWY6YAxWgAo2gAAlPHrCkCiK7W/uyE82+9vdYy9JtH0sNxvotFEJHENCdQlCABi2ruvNvIRAkHAbiEkICQgJCAkYE/D+p/823VxKzWNfbAlQITSmYwCkdCaASJJZzIKO7TjnSUBRJIFtHPtx66YLkcLKAAAetGLiopXvZGXVgKpAo1YHnCujie1pa4Yf2G4pHWMm3mcEorCslJ576Nvx5Sv3/HOv1wUAegJqMQTUQHXBUGAGpkb3cnUGREzSMz7WKk+VqqPmPeJmMHuZOpMjcwNSHNNECTAcYQ9j8yF/m9esCz7xFJ+3gfA63SdSJby88ay7BMXPhx73vNe+WUniY2nVgLuPZdtpitlgFkJIEwAbxDPMiDMrIREBh5eGwgrICDTZgaKmnNDRygkICQgJOApNIMidNh1N6zA7L93T7LZrA4sAY7jsEdkJgB/yzmeZ4JIAHmeZ159/eK+aCJxksQcMKbxnaRIiFVd1/T3nudMNPLxnVGo5HZPHgDSZ52hWCLxk23b1yw76trxuGvH424kEvMsFXk/Go/eSb/pXAFIWmuCJAEC0NWIbT9TKS9XCfTIPSAEIYCjsfjb6TPeLc9zJtLptAoAAUKeR+a1t5yeeg0v1qpVQwR7rVfX/FEHmABzGMDE7NAQ7QckEGawtgJLRAi0RYAiIJDw9hWcDiQgYsckdIRCAkICQgJCAvYyAe1maXcjm0uMXXl22wTUaxVqs/lARNb36xGE0Z5TJM25a4NQJds2vQhEhFZU+xllbrORjIpTuWUAJSbWENKAyKMDAogmEAlkurV66Ne0NL6KZozRBJARwMhaAAYgY4wmIZpprb3zIFM4zawIgJYNAECzFdEASiv52eWGMDweCZB0OsO3b49WGTRqx7oUK2URK+LmIFZExBSNd0dr1fIU6rWbgNCE52rPI+M4wpfODd/1/dqtnlS/pZhZKYuU1RzKIsXMPal+y/drty6dG77bSqe7R6BFhKhmbpaKuameVH9UKYssK7I6lGVRJGJbiWSvAvHo+eFnq5mMcDsRaVsqkM2OaMdx+OuP3csrpaWLACbFmAVjTE5rvSjG5ECY8ev1cSPmePbzD+Ycx10NiV0XAgJs4VPLxfx1Ip4SYxaM1jmjdU6MWSDiqeVi/rotfArUXNPUadcFvTF8cE6q+nilXBon5hmt/Zzv1xe19nMisgCmydzc3xdPHxu47DjC7fQI/utGycOOYw3OxpKPbGR16a9Gzy+tqvEW7G9aGzy7eW1wt1pld4x0OqO2yhtsmQdoVYc323ub6vDT1CxNG1/obZqg/9gfsGfb5UOECBEiRIgQjxX/AG48qf1pOtRTAAAAAElFTkSuQmCC">
<style>
:root{--bg:#0d1117;--card:#161b22;--line:#272e38;--fg:#e6edf3;--mut:#8b949e;--acc:#e0645a;--acc2:#58a6ff;--ok:#3fb950}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1060px;margin:0 auto;padding:24px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:16px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:13px;margin:0 0 12px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em}
.mut{color:var(--mut);font-size:13px}
input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:#0b0f14;color:var(--fg);font-size:15px;margin-top:6px}
button{background:var(--acc);border:none;color:#fff;padding:10px 14px;border-radius:8px;font-size:14px;cursor:pointer}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--fg)}
.tab{padding:6px 12px;font-size:13px}.tab.on{background:var(--acc)}.tab:not(.on){background:transparent;border:1px solid var(--line);color:var(--fg)}
.err{background:#2d1517;border:1px solid #6e2c31;color:#ffa198;border-radius:8px;padding:10px 12px;margin:10px 0;font-size:13px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.spread{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.grid2 .card{margin-bottom:0}
.kpi{font-size:26px;font-weight:650;line-height:1.2;font-variant-numeric:tabular-nums}
.kd{font-size:11px}
.brow{display:grid;grid-template-columns:minmax(0,1.3fr) 2fr auto;gap:10px;align-items:center;padding:5px 0;font-size:13px}
.brow>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brow>span:last-child{font-variant-numeric:tabular-nums;color:var(--mut)}
.bar{background:var(--acc);opacity:.75;height:8px;border-radius:4px}
.site{display:flex;justify-content:space-between;align-items:center;padding:14px 4px;border-bottom:1px solid var(--line);cursor:pointer;color:inherit;text-decoration:none}
.site:hover{background:#1b222c}
.site:last-child{border-bottom:0}
.hide{display:none}
svg text{fill:var(--mut);font-size:10px}
.flag{margin-right:6px}
</style>
</head>
<body>
<div class="wrap">
  <div id="login" class="card" style="max-width:400px;margin:60px auto">
    <h1>Analytics</h1>
    <p class="mut">Sign in to view your traffic.</p>
    <div id="loginErr"></div>
    <form id="loginForm">
      <label class="mut">Email<input id="email" type="email" autocomplete="username" required></label>
      <label class="mut" style="display:block;margin-top:12px">Password<input id="password" type="password" autocomplete="current-password" required></label>
      <div id="newPwWrap" class="hide"><label class="mut" style="display:block;margin-top:12px">Choose a new password<input id="newPassword" type="password" autocomplete="new-password"></label><div class="mut" style="margin-top:6px">${passwordRules()}</div></div>
      <button id="loginBtn" style="width:100%;margin-top:16px" type="submit">Sign in</button>
    </form>
  </div>

  <div id="app" class="hide">
    <div class="spread" style="margin-bottom:16px">
      <h1 id="title">Your sites</h1>
      <div class="row">
        <span id="who" class="mut"></span>
        <button class="ghost tab" id="signout">Sign out</button>
      </div>
    </div>
    <div id="err"></div>
    <div id="sites" class="card"></div>
    <div id="detail" class="hide"></div>
  </div>
</div>
<script>
(function(){
"use strict";
var REGION=${js(cfg.region)},CLIENT=${js(cfg.userPoolClientId)};
var COG="https://cognito-idp."+REGION+".amazonaws.com/";
var tok=null,sites=[],cur=null,days=7,custom=null,challengeSession=null,csvStore={};
var $=function(id){return document.getElementById(id)};
function show(el,on){el.classList[on?"remove":"add"]("hide")}
function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML}
function nfmt(n){return (n||0).toLocaleString()}

// Country code → emoji flag + English name. Pure presentation, derived from the
// two-letter code we already store — nothing extra is collected.
function flag(cc){
  if(!/^[A-Z]{2}$/.test(cc))return "";
  return String.fromCodePoint(0x1F1E6+cc.charCodeAt(0)-65,0x1F1E6+cc.charCodeAt(1)-65);
}
var NAMES;try{NAMES=new Intl.DisplayNames(["en"],{type:"region"})}catch(e){NAMES=null}
function cname(cc){try{return (NAMES&&NAMES.of(cc))||cc}catch(e){return cc}}

var RULES=${js(passwordRules())};
function cognito(target,body){
  return fetch(COG,{method:"POST",headers:{"content-type":"application/x-amz-json-1.1","x-amz-target":"AWSCognitoIdentityProviderService."+target},body:JSON.stringify(body)})
    .then(function(r){return r.json().then(function(j){
      if(!r.ok){
        // Cognito's raw policy error never states the actual rule — say the one that does.
        var t=j.__type||"";
        if(t.indexOf("InvalidPasswordException")>=0)throw new Error("That password doesn't meet the requirements. "+RULES);
        throw new Error(j.message||"Sign-in failed");
      }
      return j;
    })});
}

function saveTokens(res){
  tok=res.IdToken;
  try{sessionStorage.setItem("tp_tok",tok)}catch(e){}
  // The long-lived refresh token (only present on a fresh sign-in, not on refreshes):
  // it silently buys new 60-minute tokens, so a viewer in good standing never sees the
  // login again — until the admin removes them, which kills this token with the account.
  if(res.RefreshToken){try{localStorage.setItem("tp_rt",res.RefreshToken)}catch(e){}}
}

// Trade the refresh token for a fresh session. Resolves true when signed in again.
function refreshSession(){
  var rt=null;try{rt=localStorage.getItem("tp_rt")}catch(e){}
  if(!rt)return Promise.resolve(false);
  return cognito("InitiateAuth",{AuthFlow:"REFRESH_TOKEN_AUTH",ClientId:CLIENT,AuthParameters:{REFRESH_TOKEN:rt}})
    .then(function(res){
      if(!res.AuthenticationResult)return false;
      saveTokens(res.AuthenticationResult);
      return true;
    }).catch(function(){return false});
}

$("loginForm").addEventListener("submit",function(ev){
  ev.preventDefault();
  var btn=$("loginBtn");btn.disabled=true;btn.textContent="Signing in…";
  $("loginErr").innerHTML="";
  var email=$("email").value.trim(),pw=$("password").value,newPw=$("newPassword").value;
  var p;
  if(challengeSession){
    p=cognito("RespondToAuthChallenge",{ChallengeName:"NEW_PASSWORD_REQUIRED",ClientId:CLIENT,Session:challengeSession,ChallengeResponses:{USERNAME:email,NEW_PASSWORD:newPw}});
  }else{
    p=cognito("InitiateAuth",{AuthFlow:"USER_PASSWORD_AUTH",ClientId:CLIENT,AuthParameters:{USERNAME:email,PASSWORD:pw}});
  }
  p.then(function(res){
    // First sign-in after an invite: Cognito demands a permanent password.
    if(res.ChallengeName==="NEW_PASSWORD_REQUIRED"){
      challengeSession=res.Session;show($("newPwWrap"),true);
      $("loginErr").innerHTML='<div class="err">Choose a new password to finish setting up your account.</div>';
      return;
    }
    if(!res.AuthenticationResult)throw new Error("Sign-in failed");
    saveTokens(res.AuthenticationResult);challengeSession=null;start();
  }).catch(function(e){
    $("loginErr").innerHTML='<div class="err">'+esc(e.message)+"</div>";
  }).then(function(){btn.disabled=false;btn.textContent="Sign in"});
});

function api(path,retried){
  return fetch(path,{headers:{authorization:"Bearer "+tok}}).then(function(r){
    if(r.status===401){
      // The 60-minute token lapsed mid-session: refresh silently ONCE and retry —
      // the login screen is for revoked or signed-out people, not for the top of every hour.
      if(!retried){
        return refreshSession().then(function(ok){
          if(ok)return api(path,true);
          signout();throw new Error("Session expired — please sign in again.");
        });
      }
      signout();throw new Error("Session expired — please sign in again.");
    }
    if(!r.ok)throw new Error("Could not load that.");
    return r.json();
  });
}

function signout(){
  tok=null;
  try{sessionStorage.removeItem("tp_tok")}catch(e){}
  try{localStorage.removeItem("tp_rt")}catch(e){}
  show($("app"),false);show($("login"),true);
}
$("signout").addEventListener("click",signout);

var gated=false;
function start(){
  show($("login"),false);show($("app"),true);
  api("/api/sites").then(function(d){
    sites=d.sites||[];gated=!!d.gated;
    $("who").textContent=(d.viewer&&d.viewer.email)||"";
    render();
  }).catch(function(e){$("err").innerHTML='<div class="err">'+esc(e.message)+"</div>"});
}

// ── routing (founder ask 2026-08-07) ──────────────────────────────────────────────
// The dashboard has REAL urls: "/" is the site list, "/site/<id>?days=30" is one site's
// statistics. Refreshing keeps you where you were, links are shareable, back and forward
// behave — and as this grows into more pages, every new view is just another path. The
// viewer Lambda serves this page for any non-/api path, so no url can 404 into a blank.
function currentRoute(){
  var m=/^\\/site\\/([^/?#]+)/.exec(location.pathname);
  var q=new URLSearchParams(location.search);
  var f=q.get("from"),t=q.get("to");
  var d=parseInt(q.get("days"),10);
  return {
    id:m?decodeURIComponent(m[1]):null,
    days:(d>=1&&d<=90)?d:7,
    custom:(f&&t&&f<=t)?{from:f,to:t}:null
  };
}
function siteUrl(id,opts){
  var o=opts||{};
  var q=o.custom?("?from="+encodeURIComponent(o.custom.from)+"&to="+encodeURIComponent(o.custom.to))
    :(o.days&&o.days!==7?("?days="+o.days):"");
  return "/site/"+encodeURIComponent(id)+q;
}
function go(url,replace){
  if(url!==location.pathname+location.search){
    history[replace?"replaceState":"pushState"]({},"",url);
  }
  render();
}
window.addEventListener("popstate",function(){render()});

/** Draw whatever the current url asks for. The ONE place a view is chosen. */
function render(){
  if(!tok)return;
  var r=currentRoute();
  if(!r.id){cur=null;custom=null;document.title="Analytics";renderSites();return}
  var site=null;
  for(var i=0;i<sites.length;i++)if(sites[i].id===r.id)site=sites[i];
  if(!site){renderMissing();return}
  cur=site;days=r.days;custom=r.custom;
  document.title=site.name+" · Analytics";
  loadDetail();
}

/** A url naming a site this viewer can't see. Same wording either way — whether it exists
 *  is not something the dashboard may reveal (the §7b enumeration guard). */
function renderMissing(){
  show($("sites"),false);show($("detail"),true);
  $("title").textContent="Not available";
  document.title="Analytics";
  $("detail").innerHTML='<div class="card"><p class="mut">That site isn\\'t available to you. It may not be shared with your account, or it may have been removed.</p>'
    +'<button class="ghost tab" id="home">← All sites</button></div>';
  $("home").addEventListener("click",function(){go("/")});
}

function renderSites(){
  show($("detail"),false);show($("sites"),true);
  $("title").textContent="Your sites";
  if(!sites.length){
    // Honest empty states: "not shared with you" and "not part of the plan" are
    // different situations and must not wear the same sentence.
    $("sites").innerHTML=gated
      ?'<p class="mut">This online dashboard is part of the Advanced Stats upgrade, which isn\\'t set up yet. The site owner can turn it on from the TrafficPoppy app.</p>'
      :'<p class="mut">No sites have been shared with you yet.</p>';
    return}
  // Real links, so a middle-click or ⌘-click opens a site in its own tab like any website.
  $("sites").innerHTML=sites.map(function(s){
    return '<a class="site" href="'+esc(siteUrl(s.id))+'"><div><strong>'+esc(s.name)+'</strong><div class="mut">'+esc(s.domain)+"</div></div><span class=\\"mut\\">View →</span></a>";
  }).join("");
  Array.prototype.forEach.call($("sites").querySelectorAll(".site"),function(el){
    el.addEventListener("click",function(ev){
      // Leave modified clicks to the browser — that's what makes them real links.
      if(ev.metaKey||ev.ctrlKey||ev.shiftKey||ev.altKey||ev.button)return;
      ev.preventDefault();go(el.getAttribute("href"));
    });
  });
}

function loadDetail(){
  show($("sites"),false);show($("detail"),true);
  $("title").textContent=cur.name;
  $("detail").innerHTML='<div class="card mut">Loading…</div>';
  var q=custom?("from="+custom.from+"&to="+custom.to):("days="+days);
  var base="/api/sites/"+encodeURIComponent(cur.id);
  // Range and the last-30-minutes ticker load together; the ticker is best-effort.
  Promise.all([
    api(base+"/range?"+q),
    api(base+"/live").catch(function(){return null;})
  ]).then(function(rs){renderDetail(rs[0].range,rs[1]&&rs[1].live)})
    .catch(function(e){$("detail").innerHTML='<div class="err">'+esc(e.message)+"</div>"});
}

// One CSV per list card, built from the same rows the bars render — nothing re-fetched.
function cell(v){return '"'+String(v==null?"":v).replace(/"/g,'""')+'"'}
function toCsv(rows){
  return "name,count\\n"+rows.map(function(r){return cell(r.key)+","+r.count}).join("\\n");
}
// Conversions carry more than a name and a count, so they get their own columns — this is
// the number people paste into a board report, and "9" without its rate says nothing.
function goalsCsv(gs,uniques){
  return "conversion,type,target,conversions,visitors who converted,rate %,visitors,previous period\\n"
    +gs.map(function(g){
      var people=g.converters||g.conversions;
      return [cell(g.name),cell(g.kind==="page"?"page":"button or link"),
        cell(g.kind==="page"?(g.path||""):'data-tp-goal="'+g.name+'"'),
        g.conversions,g.converters,(uniques>0?Math.round(people/uniques*1000)/10:""),uniques,g.prevConversions].join(",");
    }).join("\\n");
}
function downloadCsv(id){
  var e=csvStore[id];if(!e)return;
  var blob=new Blob([e.csv||toCsv(e.rows)],{type:"text/csv"});
  var a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=e.name+".csv";
  document.body.appendChild(a);a.click();
  setTimeout(function(){URL.revokeObjectURL(a.href);a.remove()},0);
}

// ── charts (hand-rolled SVG — no libraries, nothing loaded from anywhere) ──────────

// Daily trend: views area + uniques line. Hour bars when the range is a single day.
function trendSvg(r){
  var W=920,H=200,P=28;
  if((r.days||[]).length<=1){
    var hours=r.hours||[],hm=Math.max.apply(null,hours.concat([1]));
    var bw=(W-2*P)/24;
    var bars="";
    for(var i=0;i<24;i++){
      var h=Math.round((hours[i]||0)/hm*(H-2*P));
      bars+='<rect x="'+(P+i*bw+1)+'" y="'+(H-P-h)+'" width="'+(bw-2)+'" height="'+h+'" rx="2" fill="var(--acc)" opacity="0.8"><title>'+i+':00 — '+nfmt(hours[i]||0)+' views</title></rect>';
      if(i%4===0)bars+='<text x="'+(P+i*bw+bw/2)+'" y="'+(H-8)+'" text-anchor="middle">'+i+':00</text>';
    }
    return '<svg viewBox="0 0 '+W+" "+H+'" style="width:100%;height:auto">'+bars+"</svg>";
  }
  var ds=r.days||[];if(!ds.length)return "";
  var max=1;for(var j=0;j<ds.length;j++)max=Math.max(max,ds[j].views);
  function x(i){return P+i*(W-2*P)/Math.max(1,ds.length-1)}
  function y(v){return H-P-(v/max)*(H-2*P)}
  var vPts="",uPts="",dots="";
  for(var k=0;k<ds.length;k++){
    vPts+=(k?" ":"")+x(k)+","+y(ds[k].views);
    uPts+=(k?" ":"")+x(k)+","+y(ds[k].uniques);
    dots+='<circle cx="'+x(k)+'" cy="'+y(ds[k].views)+'" r="7" fill="transparent"><title>'+ds[k].day+" — "+nfmt(ds[k].views)+" views, "+nfmt(ds[k].uniques)+" visitors</title></circle>";
  }
  var area='<polygon points="'+x(0)+","+(H-P)+" "+vPts+" "+x(ds.length-1)+","+(H-P)+'" fill="var(--acc)" opacity="0.15"/>';
  var lbl='<text x="'+P+'" y="'+(H-8)+'">'+ds[0].day+'</text><text x="'+(W-P)+'" y="'+(H-8)+'" text-anchor="end">'+ds[ds.length-1].day+"</text>"
    +'<text x="'+(W-P)+'" y="14" text-anchor="end"><tspan fill="var(--acc)">■</tspan> views  <tspan fill="var(--acc2)">■</tspan> visitors</text>';
  return '<svg viewBox="0 0 '+W+" "+H+'" style="width:100%;height:auto">'+area
    +'<polyline points="'+vPts+'" fill="none" stroke="var(--acc)" stroke-width="2"/>'
    +'<polyline points="'+uPts+'" fill="none" stroke="var(--acc2)" stroke-width="2" stroke-dasharray="4 3"/>'
    +dots+lbl+"</svg>";
}

// Traffic flow — the "money flow" of visits (§7d): where visitors come IN (sources),
// which pages they land on and move through, and where they LEAVE. Three columns of
// nodes joined by ribbons whose thickness is the count. Aggregate counts only.
function flowSvg(r){
  var entries=r.entries||[],edges=r.edges||[];
  if(!entries.length&&!edges.length)return "";
  var TOP=6;
  function top(list,key){
    var sums={};list.forEach(function(e){sums[e[key]]=(sums[e[key]]||0)+e.count});
    return Object.keys(sums).map(function(k){return{k:k,c:sums[k]}})
      .sort(function(a,b){return b.c-a.c||a.k.localeCompare(b.k)}).slice(0,TOP);
  }
  var srcs=top(entries,"source");
  // Middle column: pages by total arrivals (landings + internal arrivals).
  var arr={};entries.forEach(function(e){arr[e.path]=(arr[e.path]||0)+e.count});
  edges.forEach(function(e){arr[e.to]=(arr[e.to]||0)+e.count});
  var pages=Object.keys(arr).map(function(k){return{k:k,c:arr[k]}})
    .sort(function(a,b){return b.c-a.c||a.k.localeCompare(b.k)}).slice(0,TOP);
  var pageSet={};pages.forEach(function(p){pageSet[p.k]=true});
  // Right column: onward destinations from the middle pages, plus "left the site".
  var outs={},outSum={};
  edges.forEach(function(e){if(pageSet[e.from]){outs[e.to]=(outs[e.to]||0)+e.count;outSum[e.from]=(outSum[e.from]||0)+e.count}});
  var exits=0;pages.forEach(function(p){exits+=Math.max(0,p.c-(outSum[p.k]||0))});
  var dests=Object.keys(outs).map(function(k){return{k:"→ "+k,c:outs[k]}})
    .sort(function(a,b){return b.c-a.c||a.k.localeCompare(b.k)}).slice(0,TOP-1);
  if(exits>0)dests.push({k:"left the site",c:exits});
  if(!srcs.length||!pages.length)return "";

  var W=920,PADX=190,GAP=6,ROWH=560/Math.max(srcs.length,pages.length,dests.length,1);
  var H=Math.min(560,Math.max(220,ROWH*Math.max(srcs.length,pages.length,dests.length)));
  function layout(list){
    var total=0;list.forEach(function(n){total+=n.c});
    var scale=(H-GAP*(list.length+1))/Math.max(1,total),yy=GAP;
    return list.map(function(n){
      var h=Math.max(14,n.c*scale);var o={k:n.k,c:n.c,y:yy,h:h};yy+=h+GAP;return o;
    });
  }
  var L=layout(srcs),M=layout(pages),R=layout(dests);
  var x1=PADX,x2=W/2-70,x3=W/2+70,x4=W-PADX;
  function node(n,x,anchor,label){
    return '<rect x="'+(anchor==="end"?x-8:x)+'" y="'+n.y+'" width="8" height="'+n.h+'" rx="3" fill="var(--acc2)" opacity="0.9"/>'
      +'<text x="'+(anchor==="end"?x-14:x+14)+'" y="'+(n.y+n.h/2+3)+'" text-anchor="'+anchor+'" style="font-size:11px;fill:var(--fg)">'+esc(label)+' <tspan style="fill:var(--mut)">'+nfmt(n.c)+"</tspan></text>";
  }
  // Ribbons: proportionally slice each node's height across its links, in rank order.
  // Colour carries direction (founder feedback): GREEN = traffic coming in,
  // RED = traffic going onward / leaving.
  function ribbons(links,from,to,fx,tx,color){
    var used={},usedT={};
    return links.map(function(l){
      var f=null,t=null,i;
      for(i=0;i<from.length;i++)if(from[i].k===l.f)f=from[i];
      for(i=0;i<to.length;i++)if(to[i].k===l.t)t=to[i];
      if(!f||!t)return "";
      var fShare=Math.min(1,l.c/f.c)*f.h,tShare=Math.min(1,l.c/t.c)*t.h;
      var fy=(used[l.f]=used[l.f]||f.y),ty=(usedT[l.t]=usedT[l.t]||t.y);
      used[l.f]=Math.min(f.y+f.h,fy+fShare);usedT[l.t]=Math.min(t.y+t.h,ty+tShare);
      var mx=(fx+tx)/2;
      return '<path d="M'+fx+","+fy+" C"+mx+","+fy+" "+mx+","+ty+" "+tx+","+ty
        +" L"+tx+","+(ty+tShare)+" C"+mx+","+(ty+tShare)+" "+mx+","+(fy+fShare)+" "+fx+","+(fy+fShare)
        +' Z" fill="'+color+'" opacity="0.3"><title>'+esc(l.f)+" → "+esc(l.t.replace(/^→ /,""))+" — "+nfmt(l.c)+"</title></path>";
    }).join("");
  }
  var inLinks=entries.filter(function(e){return pageSet[e.path]}).map(function(e){return{f:e.source,t:e.path,c:e.count}});
  var destSet={};R.forEach(function(d){destSet[d.k]=true});
  var outLinks=edges.filter(function(e){return pageSet[e.from]&&destSet["→ "+e.to]}).map(function(e){return{f:e.from,t:"→ "+e.to,c:e.count}});
  pages.forEach(function(p){var ex=Math.max(0,p.c-(outSum[p.k]||0));if(ex>0&&destSet["left the site"])outLinks.push({f:p.k,t:"left the site",c:ex})});

  return '<svg viewBox="0 0 '+W+" "+H+'" style="width:100%;height:auto">'
    +ribbons(inLinks,L,M,x1+8,x2,"var(--ok)")+ribbons(outLinks,M,R,x3,x4-8,"#ff7b72")
    +L.map(function(n){return node(n,x1,"end",n.k==="direct"?"direct / typed in":n.k)}).join("")
    +M.map(function(n){return node(n,x2,"start",n.k)}).join("")
    +R.map(function(n){return node(n,x4,"end",n.k.replace(/^→ /,""))}).join("")
    +"</svg>";
}

var FOLD=8,csvSeq=0;
function bars(title,rows,empty,labelOf){
  if(!rows||!rows.length)return '<div class="card"><h2>'+title+'</h2><p class="mut">'+empty+"</p></div>";
  var id="l"+(++csvSeq);
  csvStore[id]={name:title.toLowerCase().replace(/[^a-z0-9]+/g,"-"),rows:rows};
  var max=rows[0].count||1;
  function row(r){
    var label=labelOf?labelOf(r.key):esc(r.key||"(direct)");
    return '<div class="brow"><span>'+label+'</span><span><span class="bar" style="display:block;width:'+Math.max(2,Math.round(r.count/max*100))+'%"></span></span><span>'+nfmt(r.count)+"</span></div>";
  }
  var head=rows.slice(0,FOLD).map(row).join("");
  var tail=rows.length>FOLD?'<div class="hide" id="more-'+id+'">'+rows.slice(FOLD).map(row).join("")+"</div>":"";
  var controls='<div class="row" style="margin-top:8px">'
    +(rows.length>FOLD?'<button class="ghost tab" data-more="'+id+'">Show all '+rows.length+"</button>":"")
    +'<button class="ghost tab" data-csv="'+id+'">CSV</button></div>';
  return '<div class="card"><h2>'+title+"</h2>"+head+tail+controls+"</div>";
}

function kpi(label,value,detail){
  return '<div class="card"><div class="mut kd">'+label+'</div><div class="kpi">'+value+"</div>"+(detail?'<div class="mut kd">'+detail+"</div>":"")+"</div>";
}

function pct(a,b){return b>0?Math.round(a/b*100)+"%":"—"}

// Δ vs the previous window of the same length — green up, red down, honest about a 0 base.
function delta(now,prev){
  if(prev===undefined||prev===null)return "";
  if(prev===0)return now>0?'<span style="color:var(--ok)">new</span>':"";
  var d=Math.round((now-prev)/prev*100);
  if(d===0)return '<span class="mut">±0%</span>';
  return d>0?'<span style="color:var(--ok)">▲ '+d+"%</span>":'<span style="color:#ff7b72">▼ '+Math.abs(d)+"%</span>";
}

// Pages that gained/lost the most vs the previous window — the "what changed" question.
function movers(cur,prev){
  if(!prev||!prev.length)return null;
  var m={};(prev||[]).forEach(function(p){m[p.key]=p.count});
  var seen={},out=[];
  (cur||[]).forEach(function(c){seen[c.key]=1;out.push({key:c.key,count:c.count,d:c.count-(m[c.key]||0)})});
  (prev||[]).forEach(function(p){if(!seen[p.key])out.push({key:p.key,count:0,d:-p.count})});
  out.sort(function(a,b){return Math.abs(b.d)-Math.abs(a.d)||a.key.localeCompare(b.key)});
  out=out.filter(function(r){return r.d!==0}).slice(0,6);
  return out.length?out:null;
}

// "Right now": per-minute views over the last half hour, from the TTL'd ticker partition.
function liveSvg(l){
  var W=340,H=44,n=l.minutes.length,bw=W/n;
  var max=1;l.minutes.forEach(function(m){max=Math.max(max,m.views)});
  return '<svg viewBox="0 0 '+W+" "+H+'" style="width:100%;height:44px">'+l.minutes.map(function(m,i){
    var h=m.views?Math.max(3,Math.round(m.views/max*(H-4))):2;
    return '<rect x="'+(i*bw+1)+'" y="'+(H-h)+'" width="'+(bw-2)+'" height="'+h+'" rx="1.5" fill="'+(m.views?"var(--ok)":"#2c333d")+'"><title>'+m.minute.slice(11)+" — "+nfmt(m.views)+"</title></rect>";
  }).join("")+"</svg>";
}

function renderDetail(r,live){
  csvStore={};csvSeq=0;
  var tabs=[1,7,30].map(function(d){return '<button class="tab'+(!custom&&d===days?" on":"")+'" data-d="'+d+'">'+(d===1?"Today":d+" days")+"</button>"}).join(" ")
    +' <button class="tab'+(custom?" on":"")+'" id="customBtn">'+(custom?esc(custom.from)+" → "+esc(custom.to):"Custom")+"</button>";
  var entriesTotal=0;(r.entries||[]).forEach(function(e){entriesTotal+=e.count});
  var depth=entriesTotal>0?(r.views/entriesTotal).toFixed(1):null;
  var known=(r.newVisitors||0)+(r.returningVisitors||0);
  var p=r.prev||{};

  var html='<div class="spread" style="margin-bottom:12px"><button class="ghost tab" id="back">← All sites</button><div class="row">'+tabs+"</div></div>";
  html+='<div id="customWrap" class="card hide"><div class="row">'
    +'<label class="mut">From<input id="fromD" type="date"></label>'
    +'<label class="mut">To<input id="toD" type="date"></label>'
    +'<button id="applyD" style="align-self:end">Apply</button>'
    +'</div><p class="mut" style="margin:8px 0 0">Up to 90 days at a time.</p></div>';

  html+='<div class="grid" style="margin-bottom:16px">'
    +kpi("Page views",nfmt(r.views),delta(r.views,p.views))
    +kpi("Unique visitors",nfmt(r.uniques),delta(r.uniques,p.uniques)||"daily uniques, summed")
    +kpi("New visitors",known?nfmt(r.newVisitors):"—",known?pct(r.newVisitors,known)+" of known":"needs fresh data")
    +kpi("Returning",known?nfmt(r.returningVisitors):"—",r.returningVisitors===0&&known?"within the salt window":"came back in the window")
    +kpi("Pages per visit",depth||"—",depth?nfmt(entriesTotal)+" visits":"")
    +"</div>";
  if(!r.receiving)html+='<div class="card mut">No visits recorded in this period yet.</div>';

  if(live&&live.minutes)html+='<div class="card"><div class="spread"><h2 style="margin:0">Right now</h2>'
    +'<span class="mut">'+nfmt(live.views)+" views in the last 30 minutes</span></div>"+liveSvg(live)+"</div>";

  var trend=trendSvg(r);
  if(trend)html+='<div class="card"><h2>'+((r.days||[]).length<=1?"Views by hour (UTC)":"Views & visitors by day")+"</h2>"+trend+"</div>";
  var flow=flowSvg(r);
  if(flow)html+='<div class="card"><h2>Traffic flow — in, through, and out</h2>'+flow+'<p class="mut" style="margin:8px 0 0"><span style="color:var(--ok)">■</span> traffic coming in · <span style="color:#ff7b72">■</span> traffic going on or leaving. Counts, never individual visitors.</p></div>';

  // Conversion goals (§7e): what the owner actually wants to happen, first among the
  // breakdowns because it outranks any list of pages. Counts and distinct converters —
  // never who.
  var gs=r.goals||[];
  var gid="g"+(++csvSeq);
  if(gs.length)csvStore[gid]={name:"conversions",csv:goalsCsv(gs,r.uniques)};
  if(gs.length)html+='<div class="card"><h2>Conversions</h2>'+gs.map(function(g){
    var rate=r.uniques>0?Math.round((g.converters||g.conversions)/r.uniques*1000)/10:null;
    return '<div class="brow" style="grid-template-columns:minmax(0,1.4fr) auto auto auto"><span>'
      +esc(g.name)+' <span class="mut">'+(g.kind==="page"?esc(g.path||""):"button or link")+'</span></span>'
      +'<span style="font-variant-numeric:tabular-nums">'+nfmt(g.conversions)+' <span class="mut">conversions</span></span>'
      +'<span class="mut">'+(g.converters?nfmt(g.converters)+" visitors":"")+'</span>'
      +'<span>'+(rate===null?"":rate+"% ")+delta(g.conversions,g.prevConversions)+"</span></div>";
  }).join("")
    +'<div class="row" style="margin-top:8px"><button class="ghost tab" data-csv="'+gid+'">CSV</button></div>'
    +'<p class="mut" style="margin:8px 0 0">Rate compares converting visitors with unique visitors in the same period.</p></div>';

  var mv=movers(r.topPages,p.topPages);
  if(mv)html+='<div class="card"><h2>Top movers vs the previous period</h2>'+mv.map(function(m){
    var up=m.d>0;
    return '<div class="brow"><span>'+esc(m.key)+'</span><span></span><span style="color:'+(up?"var(--ok)":"#ff7b72")+'">'+(up?"▲ +":"▼ ")+nfmt(m.d)+"</span></div>";
  }).join("")+"</div>";

  html+='<div class="grid2">';
  html+=bars("Top pages",r.topPages,"No pages yet");
  html+=bars("Referrers",r.topReferrers,"Direct visits only so far");
  if(r.countries&&r.countries.length)html+=bars("Countries",r.countries,"",function(cc){return '<span class="flag">'+flag(cc)+"</span>"+esc(cname(cc))});
  html+=bars("Browsers",r.browsers,"—");
  html+=bars("Operating systems",r.os,"—");
  html+=bars("Screen sizes",r.sizes,"—");
  if(r.utmSources&&r.utmSources.length)html+=bars("Campaign sources",r.utmSources,"");
  if(r.utmCampaigns&&r.utmCampaigns.length)html+=bars("Campaigns",r.utmCampaigns,"");
  html+="</div>";

  $("detail").innerHTML=html;
  // Every navigation goes through the url — including the range, so a refresh or a shared
  // link comes back to the same period, not to a default week.
  $("back").addEventListener("click",function(){go("/")});
  Array.prototype.forEach.call($("detail").querySelectorAll(".tab[data-d]"),function(el){
    el.addEventListener("click",function(){go(siteUrl(cur.id,{days:+el.getAttribute("data-d")}))});
  });
  $("customBtn").addEventListener("click",function(){$("customWrap").classList.toggle("hide")});
  if(custom){$("fromD").value=custom.from;$("toD").value=custom.to;}
  $("applyD").addEventListener("click",function(){
    var f=$("fromD").value,t=$("toD").value;
    if(f&&t&&f<=t)go(siteUrl(cur.id,{custom:{from:f,to:t}}));
  });
  // One delegated handler covers every list's Show-all and CSV controls.
  $("detail").addEventListener("click",function(ev){
    var el=ev.target;if(!el||!el.getAttribute)return;
    var more=el.getAttribute("data-more"),csv=el.getAttribute("data-csv");
    if(more){var m=$("more-"+more);var open=m.classList.toggle("hide");el.textContent=open?"Show all "+(csvStore[more].rows.length):"Show fewer";}
    if(csv)downloadCsv(csv);
  });
}

// Boot: same-tab token first (fast path), else the refresh token silently restores the
// session — a viewer who signed in last month lands straight on their numbers.
(function(){
  var saved=null;try{saved=sessionStorage.getItem("tp_tok")}catch(e){}
  if(saved){tok=saved;start();return}
  refreshSession().then(function(ok){if(ok)start()});
})();
})();
</script>
</body>
</html>`;
}
