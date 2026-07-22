/**
 * iOS-style segmented control: one tinted track, an animated pill indicator
 * (reanimated spring), equal-width segments. Used for view/group toggles.
 */
import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring
} from 'react-native-reanimated'
import { appleRadii, appleSprings, appleSurfaces, appleType } from '../../theme/apple-tokens'
import { triggerSelection } from '../../platform/haptics'

export function AppleSegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel
}: {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  accessibilityLabel?: string
}): React.JSX.Element {
  const index = Math.max(0, options.findIndex((o) => o.value === value))
  const position = useSharedValue(index)
  const [trackWidth, setTrackWidth] = React.useState(0)
  const segmentWidth = trackWidth > 0 ? (trackWidth - 4) / options.length : 0

  React.useEffect(() => {
    position.value = withSpring(index, appleSprings.press)
  }, [index, position])

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: 2 + position.value * segmentWidth }]
  }))

  return (
    <View
      style={styles.track}
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width
        if (w !== trackWidth) setTrackWidth(w)
      }}
    >
      {segmentWidth > 0 ? (
        <Animated.View style={[styles.indicator, { width: segmentWidth }, indicatorStyle]} />
      ) : null}
      {options.map((option) => {
        const selected = option.value === value
        return (
          <Pressable
            key={option.value}
            style={styles.segment}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => {
              if (!selected) {
                triggerSelection()
                onChange(option.value)
              }
            }}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    position: 'relative',
    borderRadius: appleRadii.tile,
    backgroundColor: appleSurfaces.group,
    padding: 2
  },
  indicator: {
    position: 'absolute',
    top: 2,
    bottom: 2,
    left: 0,
    borderRadius: appleRadii.tile - 2,
    backgroundColor: appleSurfaces.raised,
    // iOS segmented pill: whisper shadow to lift from the track.
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 5
  },
  segmentText: {
    ...appleType.footnote,
    color: appleSurfaces.secondaryLabel
  },
  segmentTextSelected: {
    fontWeight: '600',
    color: appleSurfaces.label
  }
})
