const CACHE_NAME = "tonus-financeiro-v2";
const APP_SHELL = ["./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png", "./logo-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Rede primeiro: sempre busca a versão mais recente quando online.
// Só usa o cache guardado se a rede falhar (uso offline).
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// Notificação push (lembrete de vencimento, enviado pela Edge Function
// enviar-lembretes-vencimento). Payload esperado: { title, body, url }.
self.addEventListener("push", (event) => {
  let dados = { title: "🔔 Tonus Financeiro", body: "Você tem uma nova notificação." };
  if (event.data) {
    try { dados = event.data.json(); } catch (e) { dados.body = event.data.text() || dados.body; }
  }
  event.waitUntil(
    self.registration.showNotification(dados.title || "🔔 Tonus Financeiro", {
      body: dados.body || "",
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      data: { url: dados.url || "./index.html" },
    })
  );
});

// Clique na notificação: foca uma aba já aberta do app, se houver, ou
// abre uma nova apontando pra URL enviada no push.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const alvo = event.notification.data && event.notification.data.url ? event.notification.data.url : "./index.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((janelas) => {
      for (const janela of janelas) {
        if (janela.url.includes(self.location.origin) && "focus" in janela) return janela.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(alvo);
    })
  );
});
