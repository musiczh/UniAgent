export const FRAME_HEALTH_PROBE = 'frame-health:probe'
export const FRAME_HEALTH_REPLY = 'frame-health:reply'

export interface FrameHealthReply {
  id: number
  kind: 'responsive' | 'painted' | 'hidden'
}
