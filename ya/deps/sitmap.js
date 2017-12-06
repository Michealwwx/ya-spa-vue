/**
 * 定义网站功能地图和路由配置信息
 * 层层引用，分散管理
 */
import {
  Vue
} from './env';
import {
  camelCase,
  upperFirst,
  kebabCase
} from 'lodash';
import hook from './hook';
import {
  getAppStore
} from './utils';
import raf from 'raf';
// 获取app级别的sitmap配置
import getSitmap from '../../src/app/sitmap';

function addUid(records: any) {
  const loop = function (records, baseIndex = '') {
    records.forEach((record, index) => {
      const uid = (baseIndex !== '' ? (baseIndex + '-' + index) : index) + '';
      record.uid = uid;
      if (record.route) {
        record.route.uid = uid;
        if (record.route.meta) { // meta里存一份
          record.route.meta.uid = uid;
        } else {
          record.route.meta = { uid };
        }
      }
      if (record.children && record.children.length) {
        loop(record.children, uid);
      }
    });
  };
  loop(records);
  return records;
};
async function extractRoutes(records: any, all: any) {
  const store = getAppStore('store'); // 获取保存的vuex store引用
  const router = getAppStore('router'); // 获取路由引用
  var routes = [];
  // records.forEach(async (record) => {
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.route) {
      let route = {
        ...record.route
      };
      const onlyPage = record.onlyPage;
      const pageTransitionName = record.pageTransitionName || ''; // 页面切换效果，默认opacity
      let isCache = record.isCache; // 是否有缓存标识，目前只控制Activity component部分
      const deepClean = record.deepClean === true; // 设置deepClean为true表示在isCache为false的情况下，执行深度清理，RealComponent将会重新生成
      const pageName = getSemanticPageName(record, all);
      // 路由访问控制，层层向上继承，严格满足每一层级限制，默认permission约束
      const validData = await getFamilyAccessConditions(record, all);

      // 默认route param以props方式传递
      if (!validData.isValid) {
        route.props = validData.props;
      }
      // 存储页面缓存名称
      if (isCache !== undefined) {
        if (isCache) {
          store.commit('cachePageAdd', pageName);
        }
      } else {
        // 默认带 :/?/# 特殊字符的路由页面会被缓存
        if (/[?|:|#]+/.test(route.path)) {
          store.commit('cachePageAdd', pageName);
          isCache = true;
        }
      }
      // 替换component
      let pageComponent = null;
      let originComponent = validData.isValid ? route.component : () => import('../../src/pages/nil/index');
      let ActivityComponent = null;
      /**
       * 创建Activity页面组件工厂，可多次创建ActivityComponent
       */
      const activityComponentFactory = () => {
        return () => {
          return new Promise((resolve) => {
            originComponent().then((mod) => {
              const exportDefault = mod.default;
              if (typeof exportDefault === 'function') {
                exportDefault(resolve);
              } else {
                resolve(exportDefault);
              }
            }).catch((evt) => { // 支付宝第一次扫码可能出现加载失败问题，提示信息后退并刷新
              alert('资源请求出现网络传输错误，请后退并重新刷新页面');
              router.go(-1); // 后退
              location.reload(); // 重新刷新
            });
          });
        };
      };
      ActivityComponent = activityComponentFactory();
      const WrapperComponent = Vue.extend({
        name: pageName,
        data() {
          return {
            coreRendered: true // 延迟渲染，减少因为切换动画导致页面渲染不出来的可能？(经测试可能是第一次网络传输中断所致，暂不考虑延时)
          };
        },
        created() {
          // setTimeout(() => {
          //   this.coreRendered = true;
          // }, 30);
        },
        mounted() {
          const $refs = this.$refs;
          let handler = raf(function tick() {
            if ($refs.index) {
              raf.cancel(handler);
              pageComponent = $refs.index;
            } else {
              handler = raf(tick);
            }
          });
        },
        destroyed() {
          pageComponent = null; // 清理引用
          if (!isCache && deepClean) { // 深度清理，重新生成Real组件工厂
            ActivityComponent = activityComponentFactory();
          }
        },
        render(h) {
          let className = {
            page: true
          };
          className[kebabCase(pageName)] = true;
          const coreRendered = this.coreRendered;
          return h('div', [coreRendered ? h(ActivityComponent, { // 放到子元素里渲染不会触发重复page transition
            props: {
              ...validData.props,
              ...this.$attr
            },
            ref: 'index',
            class: className
          }) : h('div', {
            'class': 'page-loading-tip',
            style: {
              textAlign: 'center',
              paddingTop: '130px'
            }
          }, '页面加载中……')]);
          // return h(ActivityComponent, {
          //   props: {
          //     ...validData.props,
          //     ...this.$attr
          //   },
          //   ref: 'index',
          //   class: className
          // });
        }
      });
      // 自定义route enter/update 进入行为
      const handleRouteChangeTo = (to) => {
        if (to.meta.uid === route.meta.uid) {
          store.commit('pageChange', WrapperComponent);
          // 是否页面独占浏览器窗口
          if (onlyPage === true) {
            store.commit('onlyPageChange', true);
          } else {
            store.commit('onlyPageChange', false);
          }
          store.commit('pageTransitionNameChange', pageTransitionName);
          // 更新路由存储信息
          store.commit('routeChange', to);
          if (pageComponent) { // route update操作
            // 调用routeUpdated回调
            const routeUpdated = pageComponent.$options.routeUpdated;
            routeUpdated && routeUpdated.call(pageComponent, to);
          }
        }
      };
      // 自定义route update/leave 离开行为
      const handleRouteChangeFrom = (from) => {
        if (from.meta.uid === route.meta.uid) {
          if (!isCache) {
            pageComponent = null; // 释放引用
          }
        }
      };
      // console.log('name', getSemanticPageName(record, all));
      // 创建Frame组件，支持activity和fragment两种路由形式
      const FrameComponent = route.frame;
      let FrameProxyComponent = route.component = {
        beforeRouteEnter(to, from, next) {
          next();
          handleRouteChangeTo(to);
        },
        beforeRouteUpdate(to, from, next) {
          next();
          handleRouteChangeFrom(from);
          handleRouteChangeTo(to);
        },
        beforeRouteLeave(to, from, next) {
          next();
          handleRouteChangeFrom(from);
        },
        destroyed() {
        }
      };
      if (record.children && record.children.length) {
        const childrenRoutes = extractRoutes(record.children, all);
        if (childrenRoutes && childrenRoutes.length) {
          route.children = childrenRoutes;
        }
        // 设置带router-view的template
        // FrameProxyComponent.template = '<router-view></router-view>';
        FrameProxyComponent.render = (h) => {
          if (FrameComponent) {
            return h('div', [
              h('router-view'),
              h(FrameComponent)
            ]);
          } else {
            return h('router-view');
          }
        };
      } else {
        FrameProxyComponent.render = () => null;
      }
      routes.push(route);
    }
  }
  return routes;
};

async function extractNavs(records: any, all: any) {
  var navs = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    // if (record.navVisible) {
    let nav = {
      uid: record.uid,
      text: record.navText,
      navVisible: record.navVisible !== false,
      breadcrumbVisible: record.breadcrumbVisible !== false,
      link: record.navLink || (record.route && (() => {
        const familyRecords = getFamilyRecords(record, all);
        return '/' + familyRecords.filter((record) => {
          return record.route;
        }).map((record) => {
          return getClearPaths(record.route.path).join('/');
        }).join('/');
      })()) || '',
      validData: await getFamilyAccessConditions(record, all)
    };
    // 扩展外链地址
    if (nav.link.slice(0, 2) === '//') {
      nav.link = location.origin + '/' + nav.link.slice(2);
    }
    if (record.children && record.children.length) {
      const childrenNavs = extractNavs(record.children, all);
      if (childrenNavs && childrenNavs.length) {
        nav.children = childrenNavs;
      }
    }
    navs.push(nav);
    // }
  }
  return navs;
}

/**
 * 查找record的所有parent记录
 * @param {Object} record
 * @param {Array} records
 */
function getFamilyRecords(record: any, records: any) {
  const uids = record.uid.split('-');
  let parentRecords = records;
  return uids.reduce((pv, cv) => {
    const currentRecord = parentRecords[cv];
    if (currentRecord.children && currentRecord.children.length) {
      parentRecords = currentRecord.children;
    }
    return pv.concat(currentRecord);
  }, []);
}

function getSemanticPageName(record, records) {
  const familyRecords = getFamilyRecords(record, records);
  return 'Page' + upperFirst(camelCase(familyRecords.filter((record) => {
    return !!record.route;
  }).map((record) => {
    return getClearPaths(record.route.path).join('-');
  }).join('-')));
}

/**
 * 获取family access conditions
 */
async function getFamilyAccessConditions(record: any, records: any) {
  const familyRecords = getFamilyRecords(record, records);
  let isValid = true;
  let props = {};
  for (let i = 0; i < familyRecords.length; i++) {
    const record = familyRecords[i];
    let result = await hook.exe('access-validation@route', record);
    result = result ? [].concat(result) : [];
    if (result.some((item) => { // 验证中断方式
      if (!item.isValid) {
        isValid = false;
        props = item.props;
        return true;
      }
    })) {
      break;
    }
  }
  return {
    isValid,
    props
  };
}

/**
 * 路径名变pageName辅助函数
 * @param {string} path
 */
function getClearPaths(path) {
  let paths = path.split('/');
  // filter掉空和参数字符串
  paths = paths.filter((frag, i) => {
    if (frag && /^[A-Za-z0-9]+$/.test(frag.charAt(0))) {
      return true;
    }
  });
  return paths;
}

/**
 * 初始化sitmap
 */
export async function init() {
  /* records = [{
    isCache: false, // 是否被缓存
    deepClean: false, // 深度清理
    navText: '', // 导航文字
    navLink: '#', // 导航链接
    navVisible: false, // 导航是否可见
    permission: 'all', // 权限控制，无具备权限将会被筛选掉
    pageTransitionName: 'opacity', // 页面切换效果
    route: {
      path: '/login', // For test
      component: () => import('../../pages/pc/login/index')
    }
  } */
  const records = getSitmap();
  // Add side effect
  addUid(records);
  return {
    routes: await extractRoutes(records, records),
    navs: await extractNavs(records, records),
    records: records
  };
};
