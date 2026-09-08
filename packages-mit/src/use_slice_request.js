import { useEffect, useRef } from 'react'

// The sliceRequest prop: an identity CHANGE requests one slice of the current plate. The ref holds the
//  last seen token so the mount value is inert (a host keeping 0 in state slices nothing until it bumps).
//  Same guards as autoSlice: an injected plate is not ours to overwrite, an empty scene has nothing to
//  slice — both are silently a no-op, matching how the slice bar simply is not pressable then. A running
//  slice is cancelled and the request retries, so the LAST request wins.
export function useSliceRequest({ sliceRequest, objectCount, gcode, sl1, pendingSliceRef, cancelSlice, onSlice, autoTimerRef }) {
  const seenRef = useRef(sliceRequest)
  useEffect(() => {
    if (sliceRequest === seenRef.current) return
    seenRef.current = sliceRequest
    if (sliceRequest == null || !objectCount || gcode != null || sl1 != null) return
    const fire = () => {
      if (pendingSliceRef.current) { cancelSlice(); autoTimerRef.current = setTimeout(fire, 300); return }
      onSlice('current')
    }
    fire()
  }, [sliceRequest])   // eslint-disable-line react-hooks/exhaustive-deps
}
