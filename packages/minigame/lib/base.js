'use strict'

const fs = require('fs')
const path = require('path')

const axios = require('axios')
const FormData = require('form-data')

const ACCESS_TOKEN_FILE = path.join(__dirname, '_access_token_minigame.json')
const SESSION_KEY_FILE = path.join(__dirname, '_session_key_minigame.json')

const {
  genMidasSig,
  genMidasMpSig
} = require('../utils/sign')

/**
 * 基础类
 * @constructor
 */
class Base {
  /**
   * 创建
   *
   * @param {object} options
   * @param {string} options.appId 小程序唯一凭证，即 AppID，可在「微信公众平台 - 设置 - 开发设置」页中获得。（需要已经成为开发者，且帐号没有异常状态）
   * @param {string} options.appSecret 小程序唯一凭证密钥，即 AppSecret，获取方式同 appid
   * @param {string} options.midasOfferId 米大师分配的offer_id
   * @param {string} options.midasSecret 米大师密钥
   * @param {string} options.baseURL 请求的基地址
   * @param {string} options.timeout 请求的超时时间，默认为 40 秒
   * @param {string} options.debug 是否输出请求日志，供内部开发调试使用
   *
   * 请求基地址默认为 `https://api.weixin.qq.com`，会指向就近路口
   * 通常情况下不需要修改该参数
   * 在该服务器不稳定的时候，可以切换到 `https://api2.weixin.qq.com` 备用服务器
   */
  constructor({
    appId,
    appSecret,
    midasOfferId,
    midasSecret,
    baseURL = 'https://api.weixin.qq.com',
    timeout = 40000,
    debug = false
  }) {
    this.appId = appId
    this.appSecret = appSecret
    this.midasOfferId = midasOfferId
    this.midasSecret = midasSecret
    this.baseURL = baseURL

    this.axios = axios.create({
      baseURL,
      timeout
    })

    this.debug = debug

    this.tokenObj = {}
    this.sessionKeyObj = {}

    this.init()
  }

  init() {

    // 从缓存文件中加载 token，模拟中继服务器
    // 可以修改为采用 redis 或者 mongodb 等方式
    if (fs.existsSync(ACCESS_TOKEN_FILE)) {
      this.tokenObj = require(ACCESS_TOKEN_FILE)
    }

    if (fs.existsSync(SESSION_KEY_FILE)) {
      this.sessionKeyObj = require(SESSION_KEY_FILE)
    }
  }

  log(...args) {
    if (this.debug)
      console.log.apply(null, args)
  }

  /**
   * 文件上传方法
   *
   * @param {object} options 传递给 request 方法的参数
   *
   * 本方法将会对 options.data 进行劫持并转换为表单方式进行提交
   */
  _upload(options) {
    return new Promise((resolve, reject) => {
      const form = new FormData()
      for (let key in options.data) {
        const value = options.data[key]
        if (value && value.hasOwnProperty('value') && value.hasOwnProperty('options')) {
          form.append(key, value.value, value.options)
        } else {
          form.append(key, value)
        }
      }

      const headers = {
        'content-type': 'application/x-www-form-urlencoded'
      }

      Object.assign(headers, form.getHeaders())

      form.getLength((err, length) => {
        if (err) {
          reject(err)
        } else {
          if (!isNaN(length)) {
            headers['content-length'] = length
          }
          options.data = form
          options.headers = headers
          this.request(options).then(res => {
            resolve(res)
          }).catch(error => {
            reject(error)
          })
        }
      })
    })
  }

  /**
   * 发送请求
   *
   * 不带 access_token，内部使用
   *
   * @param {object} options 传给 axios 的请求参数
   */
  _request(options) {
    return new Promise((resolve, reject) => {
      this.axios(options).then(response => {
        const res = {...response.data}

        if (+res.errcode) {
          reject(res)
        } else {
          resolve(res)
        }
        this.log('then', response)
      }).catch(error => {
        reject(error)
        this.log('catch', error)
      })
    })
  }

  /**
   * 发送请求
   *
   * 带有 access_token
   *
   * @param {object} options 传给 axios 的请求参数
   * @param {string} options.method 请求方式，默认为 POST
   */
  request(options) {

    if (!options.method) {
      options.method = 'post'
    }

    return new Promise((resolve, reject) => {
      this.getAccessToken().then(({access_token}) => {
        if (options.params) {
          options.params.access_token = access_token
        } else {
          options.params = {access_token}
        }
        this._request(options).then(res => {
          resolve(res)
        }).catch(error2 => {
          reject(error2)
        })
      }).catch(error => {
        reject(error)
      })

    })
  }

  /**
   * 获取 accessToken
   */
  getAccessToken() {
    // 如果缓存中有有效 token，则直接获取并返回
    if (
      this.tokenObj.access_token
      && Date.now() - this.tokenObj._time <= (this.tokenObj.expire_in || 7200) * 1000 - 5000
    ) {
      return Promise.resolve(this.tokenObj)
    }

    return new Promise((resolve, reject) => {
      this._request({
        url: '/cgi-bin/token',
        params: {
          grant_type: 'client_credential',
          appid: this.appId,
          secret: this.appSecret
        }
      }).then(data => {
        // 获取 access_token 之后更新缓存
        data._time = Date.now()
        this.tokenObj = data
        fs.writeFile(ACCESS_TOKEN_FILE, JSON.stringify(data), () => {})
        resolve(data)
      }).catch(error => {
        reject(error)
      })
    })
  }

  /**
   * 米大师请求接口
   *
   * @param {string} url 请求的 URI
   * @param {object} data 请求的参数
   */
  _midas({url, data = {}}) {
    const session_key = this.sessionKeyObj[data.openid]

    // 如果没有 session_key，则提前返回
    if (!session_key) {
      return Promise.reject(401)
    }

    return new Promise((resolve, reject) => {
      this.getAccessToken().then(({access_token}) => {

        data.appid = this.appId
        data.offer_id = this.midasOfferId
        data.ts = Math.floor(Date.now() / 1000)

        // 计算签名
        data.sig = genMidasSig(data, url, this.midasSecret)
        data.mp_sig = genMidasMpSig(data, url, access_token, session_key)

        this._request({
          url,
          method: 'post',
          params: {
            access_token
          },
          data
        }).then(res => {
          resolve(res)
        }).catch(error2 => {
          reject(error2)
        })
      }).catch(error => {
        reject(error)
      })
    })
  }

  /**
   * 登录凭证校验
   *
   * @param {String} code 登录时获取的 code
   */
  code2Session(code) {
    return new Promise((resolve, reject) => {
      this._request({
        url: `/sns/jscode2session`,
        params: {
          appid: this.appId,
          secret: this.appSecret,
          js_code: code,
          grant_type: 'authorization_code'
        }
      }).then(data => {
        // 存入缓存
        this.sessionKeyObj[data.openid] = data.session_key
        fs.writeFile(SESSION_KEY_FILE, JSON.stringify(this.sessionKeyObj), () => {})
        resolve(data)
      }).catch(error => {
        reject(error)
      })
    })
  }
}

module.exports = Base
