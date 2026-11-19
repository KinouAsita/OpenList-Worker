export interface DriverChaoXingQBankAddition {
  user_name: string
  password: string
  course_id: string
  root_dir_id?: string
  cookie?: string
}

export interface QBankQuestionItem {
  id: string
  content: string
  createTime?: number
  lastUpdateTime?: number
}

export interface QBankRelationItem {
  id: number
  pid: number
  dirName?: string
  createTime?: number
  lastUpdateTime?: number
  questionBank?: QBankQuestionItem | null
}

export interface QBankSearchResp {
  total?: number
  questionBankRelationList?: QBankRelationItem[]
}

export interface QBankUploadTokens {
  enc2: string
  t: string
  uid: string
}
