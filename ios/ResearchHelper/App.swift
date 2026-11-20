import SwiftUI
import WebKit

// Research Helper for iPhone: a full-screen web view of the phone layout served
// by the Research Helper bridge on your Mac (npm run mobile). Claude runs on the
// Mac; the phone pairs once with the link the bridge prints.

let bg = Color(red: 11 / 255, green: 11 / 255, blue: 12 / 255)

@main
struct ResearchHelperApp: App {
  var body: some Scene {
    WindowGroup { Root().preferredColorScheme(.dark) }
  }
}

enum Pairing {
  static let key = "pairURL"
  static var bundled: [String] {
    ["RHPairURL", "RHPairFallbackURL"].compactMap { Bundle.main.object(forInfoDictionaryKey: $0) as? String }.filter { $0.hasPrefix("http") }
  }
  static var saved: String? {
    get { UserDefaults.standard.string(forKey: key) }
    set { UserDefaults.standard.set(newValue, forKey: key) }
  }
  // Accepts the pairing link the Mac prints, with or without next=mobile.
  static func normalize(_ raw: String) -> URL? {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if !s.hasPrefix("http") { s = "http://" + s }
    guard var c = URLComponents(string: s), c.host != nil else { return nil }
    var items = c.queryItems ?? []
    if !items.contains(where: { $0.name == "next" }) { items.append(URLQueryItem(name: "next", value: "mobile")) }
    c.queryItems = items
    return c.url
  }
}

struct Root: View {
  @State private var candidates: [URL] = []
  @State private var index = 0
  @State private var failed: String?
  @State private var setup = false
  @State private var reloadID = UUID()

  var body: some View {
    ZStack {
      bg.ignoresSafeArea()
      if setup || candidates.isEmpty {
        PairView { url in
          Pairing.saved = url.absoluteString
          candidates = [url]
          index = 0
          failed = nil
          setup = false
          reloadID = UUID()
        }
      } else {
        WebView(url: candidates[index], onFail: { msg in
          if index + 1 < candidates.count { index += 1; reloadID = UUID() } else { failed = msg }
        }, onLoad: { url in
          Pairing.saved = url.absoluteString
          failed = nil
        })
        .id(reloadID)
        if let failed { Offline(message: failed, retry: { start() }, change: { setup = true }) }
      }
    }
    .onAppear(perform: start)
  }

  func start() {
    let list = ([Pairing.saved].compactMap { $0 } + Pairing.bundled).compactMap { Pairing.normalize($0) }
    var seen = Set<String>()
    candidates = list.filter { seen.insert($0.absoluteString).inserted }
    index = 0
    failed = nil
    reloadID = UUID()
  }
}

struct Offline: View {
  let message: String
  let retry: () -> Void
  let change: () -> Void
  var body: some View {
    VStack(spacing: 14) {
      Text("CAN'T REACH YOUR MAC").font(.system(size: 12, weight: .semibold)).tracking(1.5).foregroundStyle(.secondary)
      Text("Start Research Helper on the Mac, on the same Wi-Fi.").font(.system(size: 26, weight: .bold)).multilineTextAlignment(.center)
      Text("cd ~/Desktop/research-helper && npm run mobile").font(.system(size: 13, design: .monospaced)).foregroundStyle(.secondary).multilineTextAlignment(.center)
      Text(message).font(.footnote).foregroundStyle(.tertiary).multilineTextAlignment(.center)
      Button(action: retry) { Text("Try again").font(.headline).foregroundStyle(.black).padding(.horizontal, 28).padding(.vertical, 12).background(Color(red: 1, green: 0.79, blue: 0.24)) }
      Button("Pair with another Mac", action: change).font(.subheadline).foregroundStyle(.secondary)
    }
    .padding(28).frame(maxWidth: .infinity, maxHeight: .infinity).background(bg)
  }
}

struct PairView: View {
  let done: (URL) -> Void
  @State private var text = ""
  var body: some View {
    VStack(spacing: 16) {
      Text("RH").font(.system(size: 34, weight: .heavy)).foregroundStyle(LinearGradient(colors: [Color(red: 1, green: 0.3, blue: 0.37), Color(red: 1, green: 0.79, blue: 0.24)], startPoint: .leading, endPoint: .trailing))
      Text("Pair with your Mac").font(.system(size: 28, weight: .bold))
      Text("On the Mac run npm run mobile, then paste the pairing link it prints.").font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
      TextField("http://…/pair?t=…", text: $text).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL).padding(12).background(Color.white.opacity(0.06))
      Button { if let u = Pairing.normalize(text) { done(u) } } label: {
        Text("Connect").font(.headline).foregroundStyle(.black).frame(maxWidth: .infinity).padding(.vertical, 12).background(Color(red: 1, green: 0.79, blue: 0.24))
      }
    }
    .padding(28)
  }
}

struct WebView: UIViewRepresentable {
  let url: URL
  let onFail: (String) -> Void
  let onLoad: (URL) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()
    config.allowsInlineMediaPlayback = true
    let web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = context.coordinator
    web.uiDelegate = context.coordinator
    web.isOpaque = false
    web.backgroundColor = UIColor(red: 11 / 255, green: 11 / 255, blue: 12 / 255, alpha: 1)
    web.scrollView.backgroundColor = web.backgroundColor
    web.scrollView.contentInsetAdjustmentBehavior = .never
    web.scrollView.bounces = false
    web.allowsBackForwardNavigationGestures = false
    #if DEBUG
    if #available(iOS 16.4, *) { web.isInspectable = true }
    #endif
    var req = URLRequest(url: url)
    req.timeoutInterval = 8
    web.load(req)
    return web
  }

  func updateUIView(_ web: WKWebView, context: Context) {}

  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    let parent: WebView
    var paired = false
    init(_ p: WebView) { parent = p }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      if !paired { paired = true; parent.onLoad(parent.url) }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
      if !paired { parent.onFail(error.localizedDescription) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
      if let r = response.response as? HTTPURLResponse, response.isForMainFrame, r.statusCode == 401 {
        decisionHandler(.cancel)
        parent.onFail("This phone is not paired with that Mac (the pairing link changed).")
        return
      }
      decisionHandler(.allow)
    }
    // Links to other sites (arXiv, docs) open in Safari, not inside the app.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
      if let u = action.request.url, action.navigationType == .linkActivated, u.host != parent.url.host {
        UIApplication.shared.open(u)
        decisionHandler(.cancel)
        return
      }
      decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
      if let u = action.request.url { UIApplication.shared.open(u) }
      return nil
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
  }
}
