// 読み込み 初期化

const topPage = /** @type { HTMLParagraphElement } */ (document.getElementById(`topPage`));
const seaCon = /** @type { HTMLDivElement } */ (document.getElementById(`searchContent`));
const display = /** @type { HTMLDivElement } */ (document.getElementById(`display`));
const modeDivs = /** @type { HTMLCollectionOf<HTMLDivElement> } */ (display.children);
const sInp = /** @type { HTMLInputElement } */ (document.getElementById(`sInp`));
const nsg = /** @type { HTMLDivElement } */ (document.getElementById(`nsg`));

// 変数

let mode = 0;

// 関数

/** 毎フレーム処理 */
const frameFunc = () => {
    for (let i = 0; i < modeDivs.length; i++) {
        modeDivs[i].style.display = (mode == i) ? `` : `none`;
    }
    requestAnimationFrame(frameFunc);
}

/** 検索結果 */
const searchResult = (word) => {
    const list = [];
    const addList = (i) => {
        const content = document.createElement(`div`);
        content.classList.add(`content`);
        const img = document.createElement(`img`);
        img.src = `https://uploads.scratch.mit.edu/get_image/project/${data[list[i]].id}_408x306.png`;
        content.appendChild(img);
        const link = document.createElement(`a`);
        link.href = `https://scratch.mit.edu/projects/${data[list[i]].id}/`;
        link.target = `_blank`;
        link.title = data[list[i]].title;
        link.textContent = data[list[i]].title;
        content.appendChild(link);
        seaCon.appendChild(content);
        list.splice(i, 1);
    }
    mode = 1;
    seaCon.textContent = ``;
    const today = new Date();
    const month = String(today.getMonth() + 1);
    const date = String(today.getDate()); 
    for (let i = 0; i < data.length; i++) {
        if (
            word == `全て` || (word != `1年前` && data[i].title.includes(word)) ||
            (word == `1年前` && data[i].history.shared.includes(`${today.getFullYear() - 1}-${month.slice(month.length - 2, month.length)}-${date.slice(date.length - 2, date.length)}`))
        ) list.push(i);
    }
    while (0 < list.length) {
        if (list.length == 1) addList(0);
        else {
            let max = 0;
            for (let i = 1; i < list.length; i++) {
                if (data[list[max]].stats.views < data[list[i]].stats.views) max = i;
            }
            addList(max);
        }
    }
}

// 全体処理

frameFunc();

addEventListener(`keydown`, (event) => { if (event.key == `Enter` && sInp.value != ``) searchResult(sInp.value) });
nsg.addEventListener(`click`, () => { if (sInp.value != ``) searchResult(sInp.value) });
topPage.addEventListener(`click`, () => { mode = 0 });