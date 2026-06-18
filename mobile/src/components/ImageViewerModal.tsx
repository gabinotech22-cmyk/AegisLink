import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  FlatList,
  Dimensions,
  StatusBar,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRef, useState, useCallback } from 'react';
import { I } from './icons';
import { MediaImage } from './MediaImage';
import type { Theme } from '../theme/vault';

interface Props {
  images: string[] | null;
  initialIndex?: number;
  onClose: () => void;
  t: Theme;
}

const { width: SW, height: SH } = Dimensions.get('window');

function ImagePage({ uri, accent }: { uri: string; accent: string }) {
  return (
    <ScrollView
      style={{ width: SW, height: SH }}
      contentContainerStyle={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
      maximumZoomScale={4}
      minimumZoomScale={1}
      bouncesZoom
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      centerContent
    >
      <MediaImage
        uri={uri}
        accent={accent}
        style={{ width: SW, height: SH }}
        resizeMode="contain"
      />
    </ScrollView>
  );
}

export function ImageViewerModal({ images, initialIndex = 0, onClose, t }: Props) {
  const insets = useSafeAreaInsets();
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  const visible = !!(images && images.length > 0);
  const safeImages = images ?? [];
  const showCounter = safeImages.length > 1;

  const viewabilityConfig = useRef({ viewAreaCoveragePercentThreshold: 50 }).current;

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
      if (viewableItems.length > 0 && viewableItems[0].index != null) {
        setCurrentIndex(viewableItems[0].index);
      }
    },
    [],
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <StatusBar hidden />
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {/* Paged horizontal list — one full-screen page per image */}
        <FlatList
          data={safeImages}
          keyExtractor={(uri, i) => `${i}-${uri}`}
          renderItem={({ item }) => <ImagePage uri={item} accent={t.accent} />}
          horizontal
          pagingEnabled
          initialScrollIndex={initialIndex}
          getItemLayout={(_, index) => ({ length: SW, offset: SW * index, index })}
          showsHorizontalScrollIndicator={false}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          removeClippedSubviews
          maxToRenderPerBatch={3}
          windowSize={3}
        />

        {/* Page counter — hidden for single images */}
        {showCounter && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: insets.top + 14,
              left: 0,
              right: 0,
              alignItems: 'center',
            }}
          >
            <View
              style={{
                backgroundColor: 'rgba(0,0,0,0.50)',
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingVertical: 4,
              }}
            >
              <Text style={{ color: '#fff', fontFamily: t.fontMono, fontSize: 13 }}>
                {`${currentIndex + 1} / ${safeImages.length}`}
              </Text>
            </View>
          </View>
        )}

        {/* Close button */}
        <Pressable
          onPress={onClose}
          hitSlop={12}
          accessibilityLabel="Close image viewer"
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
      </View>
    </Modal>
  );
}
