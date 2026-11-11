import { useEffect, useState } from 'react'
import type { ProjectDirectoryGrant } from '../../shared/ipc-channels'
import { useProjectStore } from '../../stores/project-store'
import { ipc } from '../../services/ipc-client'
import { useLocaleStore } from '../../stores/locale-store'

/** 新建作品：名称与保存位置，创建后其余设定在设定页填写。 */
export function useNewProjectForm(open: boolean, onClose: () => void) {
  const createProject = useProjectStore((s) => s.createProject)
  const locale = useLocaleStore(s => s.locale)
  const [name, setName] = useState('')
  const [path, setPath] = useState<ProjectDirectoryGrant | null>(null)
  const [platform, setPlatform] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!open) return
    let mounted = true
    Promise.resolve().then(() => {
      if (!mounted) return
      setName('')
      setPath(null)
      // 网页版没有可选的文件夹：保存位置固定在服务器上，自动预填一次
      // （走 dialog:select-folder 的服务端实现，不弹任何窗口），省掉多余的「选择」。
      if (!ipc.isElectron) {
        void ipc.invoke('dialog:select-folder', 'project-create').then(selected => {
          if (mounted && selected) setPath(selected)
        })
      }
    })
    return () => { mounted = false }
  }, [open])

  const selectFolder = async () => {
    const selected = await ipc.invoke('dialog:select-folder', 'project-create')
    if (selected) setPath(selected)
  }

  /** 类型与目标读者留空，在设定页填写。 */
  const create = async () => {
    if (!name.trim() || !path) return
    setCreating(true)
    const success = await createProject({
      name: name.trim(),
      parentGrantId: path.grantId,
      genre: '',
      targetAudience: '',
      writingLanguage: locale,
    })
    setPath(null)
    setCreating(false)
    if (success) onClose()
  }

  return { name, setName, path, selectFolder, platform, setPlatform, creating, canCreate: !creating && Boolean(name.trim()) && path !== null, create }
}
