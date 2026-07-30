// The browser dashboard's HTML, served by the viewer Lambda (DESIGN.md §7b).
//
// Dependency-free on purpose: this page is embedded in a Lambda that shares a zip with the
// hot collector path, and a viewer's first paint should not wait on a framework download.
// It talks to Cognito directly for login and to /api/* for data.
//
// It renders NO data before authentication — the markup below contains only a login form;
// every number arrives from an authenticated fetch afterwards.

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
<style>
:root{--bg:#0d1117;--card:#161b22;--line:#272e38;--fg:#e6edf3;--mut:#8b949e;--acc:#e0645a;--ok:#3fb950}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:24px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:16px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 12px}
.mut{color:var(--mut);font-size:13px}
input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:#0b0f14;color:var(--fg);font-size:15px;margin-top:6px}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:15px;font-weight:600;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
.err{background:#3d1a1a;border:1px solid #6b2b2b;color:#ffb4ab;padding:10px 12px;border-radius:8px;margin:12px 0;font-size:14px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.spread{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.kpi{font-size:30px;font-weight:650;letter-spacing:-.5px}
.bar{height:8px;background:var(--acc);border-radius:4px;min-width:2px}
.brow{display:grid;grid-template-columns:1fr 120px 52px;gap:10px;align-items:center;padding:5px 0;font-size:14px}
.brow span:last-child{text-align:right;color:var(--mut)}
.tab{background:transparent;border:1px solid var(--line);color:var(--mut);padding:6px 12px;font-size:13px}
.tab.on{color:var(--fg);border-color:var(--acc)}
.site{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--line);cursor:pointer}
.site:last-child{border-bottom:0}
.hide{display:none}
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
      <div id="newPwWrap" class="hide"><label class="mut" style="display:block;margin-top:12px">Choose a new password<input id="newPassword" type="password" autocomplete="new-password"></label></div>
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
var tok=null,sites=[],cur=null,days=7,challengeSession=null;
var $=function(id){return document.getElementById(id)};
function show(el,on){el.classList[on?"remove":"add"]("hide")}
function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML}
function nfmt(n){return (n||0).toLocaleString()}

function cognito(target,body){
  return fetch(COG,{method:"POST",headers:{"content-type":"application/x-amz-json-1.1","x-amz-target":"AWSCognitoIdentityProviderService."+target},body:JSON.stringify(body)})
    .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.message||"Sign-in failed");return j})});
}

function saveTokens(res){
  tok=res.IdToken;
  try{sessionStorage.setItem("tp_tok",tok)}catch(e){}
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

function api(path){
  return fetch(path,{headers:{authorization:"Bearer "+tok}}).then(function(r){
    if(r.status===401){signout();throw new Error("Session expired — please sign in again.")}
    if(!r.ok)throw new Error("Could not load that.");
    return r.json();
  });
}

function signout(){
  tok=null;try{sessionStorage.removeItem("tp_tok")}catch(e){}
  show($("app"),false);show($("login"),true);
}
$("signout").addEventListener("click",signout);

function start(){
  show($("login"),false);show($("app"),true);
  api("/api/sites").then(function(d){
    sites=d.sites||[];
    $("who").textContent=(d.viewer&&d.viewer.email)||"";
    renderSites();
  }).catch(function(e){$("err").innerHTML='<div class="err">'+esc(e.message)+"</div>"});
}

function renderSites(){
  show($("detail"),false);show($("sites"),true);
  $("title").textContent="Your sites";
  if(!sites.length){$("sites").innerHTML='<p class="mut">No sites have been shared with you yet.</p>';return}
  $("sites").innerHTML=sites.map(function(s,i){
    return '<div class="site" data-i="'+i+'"><div><strong>'+esc(s.name)+'</strong><div class="mut">'+esc(s.domain)+"</div></div><span class=\\"mut\\">View →</span></div>";
  }).join("");
  Array.prototype.forEach.call($("sites").querySelectorAll(".site"),function(el){
    el.addEventListener("click",function(){open(sites[+el.getAttribute("data-i")])});
  });
}

function open(site){cur=site;loadDetail()}

function loadDetail(){
  show($("sites"),false);show($("detail"),true);
  $("title").textContent=cur.name;
  $("detail").innerHTML='<div class="card mut">Loading…</div>';
  api("/api/sites/"+encodeURIComponent(cur.id)+"/range?days="+days).then(function(d){renderDetail(d.range)})
    .catch(function(e){$("detail").innerHTML='<div class="err">'+esc(e.message)+"</div>"});
}

function bars(title,rows,empty){
  if(!rows||!rows.length)return '<div class="card"><h2>'+title+'</h2><p class="mut">'+empty+"</p></div>";
  var max=rows[0].count||1;
  return '<div class="card"><h2>'+title+"</h2>"+rows.map(function(r){
    return '<div class="brow"><span>'+esc(r.key||"(direct)")+'</span><span><span class="bar" style="display:block;width:'+Math.max(2,Math.round(r.count/max*100))+'%"></span></span><span>'+nfmt(r.count)+"</span></div>";
  }).join("")+"</div>";
}

function renderDetail(r){
  var tabs=[1,7,30].map(function(d){return '<button class="tab'+(d===days?" on":"")+'" data-d="'+d+'">'+(d===1?"Today":d+" days")+"</button>"}).join(" ");
  var html='<div class="spread" style="margin-bottom:12px"><button class="ghost tab" id="back">← All sites</button><div class="row">'+tabs+"</div></div>";
  html+='<div class="grid" style="margin-bottom:16px">'
    +'<div class="card"><div class="mut">Page views</div><div class="kpi">'+nfmt(r.views)+"</div></div>"
    +'<div class="card"><div class="mut">Unique visitors</div><div class="kpi">'+nfmt(r.uniques)+'</div><div class="mut">daily uniques, summed</div></div>'
    +"</div>";
  if(!r.receiving)html+='<div class="card mut">No visits recorded in this period yet.</div>';
  html+=bars("Top pages",r.topPages,"No pages yet");
  html+=bars("Referrers",r.topReferrers,"Direct visits only so far");
  if(r.countries&&r.countries.length)html+=bars("Countries",r.countries,"");
  html+=bars("Browsers",r.browsers,"—");
  html+=bars("Operating systems",r.os,"—");
  $("detail").innerHTML=html;
  $("back").addEventListener("click",renderSites);
  Array.prototype.forEach.call($("detail").querySelectorAll(".tab[data-d]"),function(el){
    el.addEventListener("click",function(){days=+el.getAttribute("data-d");loadDetail()});
  });
}

try{var saved=sessionStorage.getItem("tp_tok");if(saved){tok=saved;start()}}catch(e){}
})();
</script>
</body>
</html>`;
}
