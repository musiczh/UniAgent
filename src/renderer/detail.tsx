import { createRoot } from 'react-dom/client'
import { DetailChatPopover } from './components/DetailChatPopover'
import './styles.css'
import './commentStyles.css'

void window.uniagent.getDetailWindow().then(initial => {
  createRoot(document.getElementById('root')!).render(<DetailChatPopover {...initial} detached
    onClose={() => window.close()} onPromoted={() => {}} onSessionCreated={() => {}} />)
}).catch(() => window.close())
