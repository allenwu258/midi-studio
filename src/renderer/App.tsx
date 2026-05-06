export function App() {
  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">midi-studio</p>
          <h1>Desktop MIDI Practice Studio</h1>
          <p className="lede">
            React and Electron are running. Player features will be built on top
            of this foundation.
          </p>
        </div>
        <div className="runtime-panel" aria-label="Runtime information">
          <span>Electron</span>
          <strong>{window.midiStudio.appVersion}</strong>
          <span>Platform</span>
          <strong>{window.midiStudio.platform}</strong>
        </div>
      </section>
    </main>
  );
}
