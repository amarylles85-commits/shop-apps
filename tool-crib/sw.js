const C='toolcrib-v2',LIB='toolcrib-libs-v1';const F=['./','index.html','crib.js','vision.js','toolvision.js','label.js','photo.js','app.js','manifest.json','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(F)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C&&x!==LIB).map(x=>caches.delete(x)))));self.clients.claim();});
// label reader / barcode libraries (versioned CDN files): cache first, so after the first online use they load with no signal
const isLib=u=>/^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|tessdata\.projectnaptha\.com)\//.test(u);
// app files: network first, cache as fallback so it opens with no signal on the shop floor
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;
  if(isLib(e.request.url)){e.respondWith(caches.open(LIB).then(c=>c.match(e.request).then(hit=>hit||fetch(e.request).then(r=>{if(r.ok)c.put(e.request,r.clone());return r;}))));return;}
  e.respondWith(fetch(e.request).then(r=>{if(r.ok&&new URL(e.request.url).origin===location.origin){const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));}return r;}).catch(()=>caches.match(e.request,{ignoreSearch:true})));});
// tapping a notification opens the app on the order list
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{for(const c of cs){if('focus' in c){c.postMessage({go:'order'});return c.focus();}}return self.clients.openWindow('./#order');}));});
