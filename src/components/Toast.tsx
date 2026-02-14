import { useEffect } from 'react'
import './Toast.css'

interface ToastProps {
  message: string | null
  onDismiss: () => void
}

export function Toast({ message, onDismiss }: ToastProps) {
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(onDismiss, 2000)
    return () => clearTimeout(timer)
  }, [message, onDismiss])

  if (!message) return null

  return (
    <div className="toast">
      {message}
    </div>
  )
}
