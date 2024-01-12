const data: Array<Array<any>> = [];
const getData = (number: number) => {
    fetch(`https://api.scratch.mit.edu/users/horiyouta/projects?limit=40&offset=${number * 40}`)
        .then(res => res.json())
        .then(resData => {
            data.push(...resData);
            if (number == 26) Deno.writeTextFile(`./data.js`, `const data = ${JSON.stringify(data)}`);
            else getData(number + 1);
        });
}
getData(0);