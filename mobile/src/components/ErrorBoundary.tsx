import { Component, type ReactNode } from 'react';
import { View, Text, Pressable } from 'react-native';

/**
 * ErrorBoundary — contains a render crash to a subtree instead of letting it
 * white-screen the whole app.
 *
 * React Native has NO default error boundary: in a release build an uncaught
 * render error tears down the entire React tree and the user sees a blank
 * screen with no recovery (red boxes only appear in dev). Wrapping a risky
 * subtree (e.g. the GIF/sticker picker, which renders remote media) keeps a
 * failure local — the rest of the app stays alive and the user can dismiss the
 * panel and carry on.
 *
 * NOTE: this catches JS render errors only. Native crashes (e.g. Fresco image
 * decoding) bypass JS entirely and must be prevented at the source.
 */
interface Props {
  children: ReactNode;
  /** Optional custom fallback. Receives a reset() to retry the subtree. */
  fallback?: (reset: () => void) => ReactNode;
  /** Optional hook for logging/telemetry (must stay metadata-free). */
  onError?: (error: Error) => void;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    this.props.onError?.(error);
  }

  reset = (): void => {
    this.setState({ hasError: false });
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.reset);

    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          gap: 12,
        }}
      >
        <Text style={{ color: '#9aa', fontSize: 14, textAlign: 'center' }}>
          Something went wrong here.
        </Text>
        <Pressable
          onPress={this.reset}
          accessibilityLabel="Retry"
          style={{
            paddingHorizontal: 20,
            paddingVertical: 9,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: '#2a3a34',
          }}
        >
          <Text style={{ color: '#cde', fontSize: 13 }}>Retry</Text>
        </Pressable>
      </View>
    );
  }
}
