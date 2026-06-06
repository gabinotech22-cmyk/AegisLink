import { Modal, View, Pressable, ScrollView, Dimensions, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { I } from './icons';
import { MediaImage } from './MediaImage';
import type { Theme } from '../theme/vault';

interface Props {
  uri: string | null;
  onClose: () => void;
  t: Theme;
}

const { width: SW, height: SH } = Dimensions.get('window');

export function ImageViewerModal({ uri, onClose, t }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={!!uri}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <StatusBar hidden />
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {/* Close button */}
        <Pressable
          onPress={onClose}
          hitSlop={12}
          style={{
            position: 'absolute',
            top: insets.top + 12,
            right: 18,
            zIndex: 10,
            backgroundColor: 'rgba(0,0,0,0.55)',
            borderRadius: 99,
            padding: 8,
          }}
        >
          <I.X size={20} color="#fff" />
        </Pressable>

        {/* Pinch-to-zoom via ScrollView */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
          maximumZoomScale={4}
          minimumZoomScale={1}
          bouncesZoom
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          centerContent
        >
          {uri ? (
            <MediaImage
              uri={uri}
              accent={t.accent}
              style={{ width: SW, height: SH }}
              resizeMode="contain"
            />
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
