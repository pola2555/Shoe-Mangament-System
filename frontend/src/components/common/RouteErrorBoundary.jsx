import { Component } from 'react';

/**
 * Catches render and chunk-load failures beneath the lazy route Suspense boundary.
 *
 * Route components are code-split, so a chunk fetch can fail — most commonly right
 * after a deploy, when the browser still holds the old HTML shell and asks for a
 * hashed filename that no longer exists. Without a boundary React unmounts the whole
 * tree and the user sees a blank page with no way forward.
 *
 * A stale-chunk failure is fixed by reloading, so that is offered as the primary action.
 */
export default class RouteErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error('Route failed to load:', error);
  }

  render() {
    if (!this.state.error) return this.props.children;

    // A failed dynamic import reports itself in a few different ways across browsers.
    const message = String(this.state.error?.message || '');
    const isChunkError = /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(message);

    return (
      <div className="card" style={{ margin: 'var(--spacing-xl)', textAlign: 'center', padding: 'var(--spacing-2xl)' }}>
        <h2 style={{ marginBottom: 'var(--spacing-sm)' }}>
          {isChunkError ? 'This page needs to reload' : 'Something went wrong'}
        </h2>
        <p style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-lg)' }}>
          {isChunkError
            ? 'The app was updated while this tab was open. Reloading will pick up the new version.'
            : 'This page failed to load. Reloading usually clears it.'}
        </p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
